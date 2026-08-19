import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress } from 'viem'

/**
 * Cross-context serialization of the pending-submission critical section when
 * the Web Locks API is unavailable. Each "tab" is a separate module graph of
 * '~/utils/pendingSubmissions' (separate realm-local FIFO queues and memory
 * maps) sharing one localStorage object — the storage-token mutex is the only
 * thing that can serialize them, exactly like two real browser tabs without
 * navigator.locks. The module under test is therefore only ever imported
 * dynamically, after the globals are stubbed.
 */

type PendingSubmissionsModule = typeof import('~/utils/pendingSubmissions')

const OWNER = getAddress('0x1000000000000000000000000000000000000000')
const LOCK_KEY = `euler_pending_submission:lock:1:${OWNER}`
const DIRECT_KEY = `euler_pending_submission:direct:1:${OWNER}`

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

const loadTab = async (): Promise<PendingSubmissionsModule> => {
  vi.resetModules()
  return import('~/utils/pendingSubmissions')
}

const armInput = (attemptId: string) => ({
  owner: OWNER,
  chainId: 1,
  completesPlan: true,
  attemptId,
})

beforeEach(() => {
  vi.stubGlobal('localStorage', createMemoryStorage())
  // No Web Locks API: the storage-token mutex must carry serialization.
  vi.stubGlobal('navigator', {})
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('pending submission lock without Web Locks', () => {
  it('lets exactly one of two concurrent tabs reach the wallet boundary', async () => {
    const tabA = await loadTab()
    const tabB = await loadTab()

    // Both tabs passed their read-only gates and race check+reserve for the
    // same wallet/chain from different flows (and different module graphs).
    const walletCalls: string[] = []
    const outcomes = await Promise.allSettled([
      tabA.armPendingSubmission('direct', armInput('attempt-a')).then(() => walletCalls.push('tab-a')),
      tabB.armPendingSubmission('batch', armInput('attempt-b')).then(() => walletCalls.push('tab-b')),
    ])

    expect(walletCalls).toHaveLength(1)
    const rejections = outcomes.filter(outcome => outcome.status === 'rejected')
    expect(rejections).toHaveLength(1)
    // Compared by name: each module graph has its own class identity.
    const reason = (rejections[0] as PromiseRejectedResult).reason as Error
    expect(reason.constructor.name).toBe('PendingSubmissionConflictError')
    expect(reason.message).toContain('Another transaction from this wallet')
  })

  it('releases the mutex after the critical section and keeps blocking on the record itself', async () => {
    const tabA = await loadTab()
    const tabB = await loadTab()

    await tabA.armPendingSubmission('direct', armInput('attempt-a'))
    // The mutex protects only the critical section — it must not stay held
    // while the reservation blocks other tabs.
    expect(localStorage.getItem(LOCK_KEY)).toBeNull()

    await expect(tabB.armPendingSubmission('batch', armInput('attempt-b')))
      .rejects.toThrow('Another transaction from this wallet')

    await expect(tabA.releasePendingSubmission('direct', OWNER, 1, { attemptId: 'attempt-a' }))
      .resolves.toBe(true)
    await expect(tabB.armPendingSubmission('batch', armInput('attempt-b')))
      .resolves.toMatchObject({ phase: 'armed', attemptId: 'attempt-b' })
  })

  it('fails closed — nothing is reserved and nothing may reach the wallet — while another context holds the mutex', async () => {
    const tab = await loadTab()
    vi.useFakeTimers()
    try {
      localStorage.setItem(LOCK_KEY, JSON.stringify({
        token: 'held-by-another-context',
        expiresAt: Date.now() + 60_000,
      }))

      const attempt = tab.armPendingSubmission('direct', armInput('attempt-a'))
      const outcome = expect(attempt).rejects.toThrow('could not take the cross-tab submission lock')
      await vi.advanceTimersByTimeAsync(11_000)
      await outcome

      expect(localStorage.getItem(DIRECT_KEY)).toBeNull()
    }
    finally {
      vi.useRealTimers()
    }
  })

  it('reclaims a mutex left behind by a crashed holder once its TTL expired', async () => {
    const tab = await loadTab()
    localStorage.setItem(LOCK_KEY, JSON.stringify({ token: 'crashed-holder', expiresAt: Date.now() - 1 }))

    await expect(tab.armPendingSubmission('direct', armInput('attempt-a')))
      .resolves.toMatchObject({ phase: 'armed', attemptId: 'attempt-a' })
    expect(localStorage.getItem(LOCK_KEY)).toBeNull()
  })
})
