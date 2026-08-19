import { beforeEach, describe, expect, it, vi } from 'vitest'
import { nextTick, ref } from 'vue'
import { getAddress, type Address, type Hash } from 'viem'
import {
  RECOVERABLE_SUBMISSION_FLOWS,
  usePendingSubmissionRecovery,
} from '~/composables/usePendingSubmissionRecovery'
import {
  armPendingSubmission,
  readPendingSubmission,
  registerActiveSubmissionAttempt,
  resetPendingSubmissionMemoryFallback,
  unregisterActiveSubmissionAttempt,
  writePendingSubmission,
} from '~/utils/pendingSubmissions'

const OWNER = getAddress('0x1000000000000000000000000000000000000000')
const OTHER_OWNER = getAddress('0x2000000000000000000000000000000000000000')
const TX_HASH = `0x${'11'.repeat(32)}` as Hash

const createMemoryStorage = (): Storage => {
  const store = new Map<string, string>()
  return {
    get length() {
      return store.size
    },
    clear: () => store.clear(),
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => [...store.keys()][index] ?? null,
    removeItem: (key: string) => {
      store.delete(key)
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value))
    },
  }
}

/** An armed record whose arming attempt died with the page — no id will ever arrive. */
const orphanedArmed = (owner: Address = OWNER) => ({
  phase: 'armed' as const,
  chainId: 1,
  owner,
  completesPlan: true,
  submittedAt: 1_000,
  attemptId: 'gone-attempt',
})

const addressRef = ref<Address | undefined>(OWNER)

beforeEach(() => {
  vi.stubGlobal('localStorage', createMemoryStorage())
  vi.stubGlobal('useWagmi', () => ({ address: addressRef }))
  addressRef.value = OWNER
  resetPendingSubmissionMemoryFallback()
})

describe('usePendingSubmissionRecovery', () => {
  it('lists orphaned armed records for every recoverable flow, never the batch flow', () => {
    for (const flow of RECOVERABLE_SUBMISSION_FLOWS) {
      writePendingSubmission(flow, orphanedArmed())
    }
    // The batch cart drawer owns its own release CTA — the app-root recovery
    // surface must not offer a second, context-free dismissal for it.
    writePendingSubmission('batch', orphanedArmed())
    const { entries, refresh } = usePendingSubmissionRecovery()

    refresh()

    expect(entries.value.map(entry => entry.flow).sort())
      .toEqual([...RECOVERABLE_SUBMISSION_FLOWS].sort())
    expect(entries.value).toEqual(RECOVERABLE_SUBMISSION_FLOWS.map(() =>
      expect.objectContaining({ owner: OWNER, chainId: 1, state: 'armed' }),
    ))
  })

  it('shows only the connected wallet\'s records and clears on disconnect', async () => {
    writePendingSubmission('direct', orphanedArmed())
    writePendingSubmission('outgoing-migration', orphanedArmed(OTHER_OWNER))
    const { entries, refresh } = usePendingSubmissionRecovery()

    refresh()
    expect(entries.value).toEqual([
      expect.objectContaining({ flow: 'direct', owner: OWNER }),
    ])

    // The address watcher refreshes the listing on wallet changes.
    addressRef.value = undefined
    await nextTick()
    expect(entries.value).toEqual([])
  })

  it('leaves records owned by a live attempt to their executor', () => {
    registerActiveSubmissionAttempt('live-attempt')
    try {
      writePendingSubmission('direct', { ...orphanedArmed(), attemptId: 'live-attempt' })
      const { entries, refresh } = usePendingSubmissionRecovery()

      refresh()

      // The executor that armed this record is still running in this realm;
      // its own settle/release path resolves it, and offering a manual
      // dismissal here would race that resolution.
      expect(entries.value).toEqual([])
    }
    finally {
      unregisterActiveSubmissionAttempt('live-attempt')
    }
  })

  it('dismisses an orphaned record after the user checked the wallet, unblocking the executors', async () => {
    writePendingSubmission('outgoing-migration', orphanedArmed())
    const { entries, releaseError, refresh, release } = usePendingSubmissionRecovery()
    refresh()
    const [entry] = entries.value
    expect(entry).toBeDefined()

    await release(entry)

    expect(releaseError.value).toBe('')
    expect(entries.value).toEqual([])
    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toBeUndefined()
    // The wallet/chain is no longer reserved: the next attempt can arm.
    await expect(armPendingSubmission('outgoing-migration', {
      owner: OWNER,
      chainId: 1,
      completesPlan: true,
      attemptId: 'new-attempt',
    })).resolves.toMatchObject({ phase: 'armed', attemptId: 'new-attempt' })
  })

  it('refuses the dismissal when the record gained a transaction id meanwhile', async () => {
    writePendingSubmission('direct', orphanedArmed())
    const { entries, releaseError, refresh, release } = usePendingSubmissionRecovery()
    refresh()
    const [entry] = entries.value
    expect(entry).toBeDefined()

    // Between the listing and the click, the wallet's answer landed (e.g.
    // relayed through another tab): the record now resolves objectively.
    writePendingSubmission('direct', {
      phase: 'submitted',
      kind: 'transaction',
      hash: TX_HASH,
      chainId: 1,
      owner: OWNER,
      completesPlan: true,
      submittedAt: 2_000,
    })

    await release(entry)

    expect(releaseError.value).toContain('cannot be dismissed')
    expect(readPendingSubmission('direct', OWNER, 1)).toMatchObject({ phase: 'submitted' })
    // The refreshed listing no longer offers it either.
    expect(entries.value).toEqual([])
  })

  it('never breaks the app shell when the listing itself fails', () => {
    const working = createMemoryStorage()
    vi.stubGlobal('localStorage', {
      ...working,
      get length(): number {
        throw new Error('storage unavailable')
      },
      key: () => {
        throw new Error('storage unavailable')
      },
      getItem: () => {
        throw new Error('storage unavailable')
      },
    })
    const { entries, refresh } = usePendingSubmissionRecovery()

    // Recovery is best-effort UI: a throwing storage must degrade to an
    // empty listing — the executors' own gates keep failing closed.
    expect(() => refresh()).not.toThrow()
    expect(entries.value).toEqual([])
  })
})
