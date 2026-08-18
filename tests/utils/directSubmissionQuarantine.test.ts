import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress, type Hash } from 'viem'
import type { PreparedPlanBroadcast } from '~/composables/useEulerTx'
import {
  createDirectSubmissionQuarantine,
  PENDING_SUBMISSION_UNRESOLVED_ERROR,
} from '~/utils/directSubmissionQuarantine'
import { readPendingSubmission, writePendingSubmission } from '~/utils/pendingSubmissions'
import { SafeTransactionStatusUnknownError } from '~/utils/safeWalletTransactions'

const safeMocks = vi.hoisted(() => ({
  waitForSafeTransactionExecution: vi.fn(),
}))

vi.mock('~/utils/safeWalletTransactions', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>()
  return {
    ...actual,
    waitForSafeTransactionExecution: safeMocks.waitForSafeTransactionExecution,
  }
})

const OWNER = getAddress('0x1000000000000000000000000000000000000000')
const OTHER_OWNER = getAddress('0x2000000000000000000000000000000000000000')
const TX_HASH = `0x${'11'.repeat(32)}` as Hash
const SAFE_TX_HASH = `0x${'22'.repeat(32)}` as Hash

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

const broadcast = (overrides: Partial<PreparedPlanBroadcast> = {}): PreparedPlanBroadcast => ({
  kind: 'transaction',
  hash: TX_HASH,
  item: 'evcBatch',
  index: 0,
  completesPlan: true,
  status: 'submitted',
  ...overrides,
})

const getSafeWalletProvider = vi.fn()

const createQuarantine = () => createDirectSubmissionQuarantine({
  flow: 'outgoing-migration',
  getSafeWalletProvider,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('localStorage', createMemoryStorage())
})

describe('sealFailure', () => {
  it('quarantines an accepted EOA batch submission after a failed attempt', () => {
    const quarantine = createQuarantine()
    quarantine.begin({ owner: OWNER, chainId: 1 })
    quarantine.track(broadcast())

    expect(quarantine.sealFailure()).toBe(true)
    expect(readPendingSubmission('outgoing-migration')).toMatchObject({
      kind: 'transaction',
      hash: TX_HASH,
      chainId: 1,
      owner: OWNER,
      completesPlan: true,
    })
  })

  it('quarantines an accepted Safe bundle proposal after a failed attempt', () => {
    const quarantine = createQuarantine()
    quarantine.begin({ owner: OWNER, chainId: 1 })
    quarantine.track(broadcast({ kind: 'proposal', hash: SAFE_TX_HASH, item: 'bundle' }))

    expect(quarantine.sealFailure()).toBe(true)
    expect(readPendingSubmission('outgoing-migration')).toMatchObject({
      kind: 'proposal',
      hash: SAFE_TX_HASH,
    })
  })

  it.each(['approval', 'pluginCall'] as const)('does not quarantine an idempotent ambiguous %s', (item) => {
    const quarantine = createQuarantine()
    quarantine.begin({ owner: OWNER, chainId: 1 })
    quarantine.track(broadcast({ item, completesPlan: false }))

    expect(quarantine.sealFailure()).toBe(false)
    expect(readPendingSubmission('outgoing-migration')).toBeUndefined()
  })

  it('does not quarantine once the submission confirmed', () => {
    const quarantine = createQuarantine()
    quarantine.begin({ owner: OWNER, chainId: 1 })
    quarantine.track(broadcast())
    quarantine.track(broadcast({ status: 'confirmed' }))

    expect(quarantine.sealFailure()).toBe(false)
  })

  it('does not quarantine when nothing was broadcast', () => {
    const quarantine = createQuarantine()
    quarantine.begin({ owner: OWNER, chainId: 1 })

    expect(quarantine.sealFailure()).toBe(false)
  })

  it('resets tracking on the next attempt', () => {
    const quarantine = createQuarantine()
    quarantine.begin({ owner: OWNER, chainId: 1 })
    quarantine.track(broadcast())
    quarantine.begin({ owner: OWNER, chainId: 1 })

    // The stale broadcast belongs to the previous attempt.
    expect(quarantine.sealFailure()).toBe(false)
  })
})

describe('reconcileBeforeAttempt', () => {
  const seal = (overrides: Partial<PreparedPlanBroadcast> = {}) => {
    const quarantine = createQuarantine()
    quarantine.begin({ owner: OWNER, chainId: 1 })
    quarantine.track(broadcast(overrides))
    expect(quarantine.sealFailure()).toBe(true)
    return quarantine
  }

  it('is clear when no submission is quarantined', async () => {
    await expect(createQuarantine().reconcileBeforeAttempt({
      owner: OWNER,
      chainId: 1,
      provider: undefined,
    })).resolves.toBe('clear')
  })

  it.each([
    ['wallet', { owner: OTHER_OWNER, chainId: 1 }],
    ['chain', { owner: OWNER, chainId: 8453 }],
  ] as const)('lets a different %s proceed while keeping the record', async (_label, attempt) => {
    const quarantine = seal()

    await expect(quarantine.reconcileBeforeAttempt({
      ...attempt,
      provider: undefined,
    })).resolves.toBe('clear')
    // Nothing that attempt sends can duplicate the record — it stays for the
    // wallet/chain that owns it.
    expect(readPendingSubmission('outgoing-migration')).toBeDefined()
  })

  it('blocks the retry while an EOA submission has no receipt', async () => {
    const quarantine = seal()
    const provider = {
      getTransactionReceipt: vi.fn(async () => {
        throw new Error('receipt not found')
      }),
    }

    await expect(quarantine.reconcileBeforeAttempt({
      owner: OWNER,
      chainId: 1,
      provider: provider as never,
    })).rejects.toThrow(PENDING_SUBMISSION_UNRESOLVED_ERROR)
    expect(readPendingSubmission('outgoing-migration')).toBeDefined()
  })

  it('blocks the retry while a Safe proposal status is unknown', async () => {
    const quarantine = seal({ kind: 'proposal', hash: SAFE_TX_HASH, item: 'bundle' })
    getSafeWalletProvider.mockResolvedValue({ request: vi.fn() })
    safeMocks.waitForSafeTransactionExecution.mockRejectedValue(
      new SafeTransactionStatusUnknownError(SAFE_TX_HASH, 'timeout'),
    )

    await expect(quarantine.reconcileBeforeAttempt({
      owner: OWNER,
      chainId: 1,
      provider: { getTransactionReceipt: vi.fn() } as never,
    })).rejects.toThrow(PENDING_SUBMISSION_UNRESOLVED_ERROR)
    expect(readPendingSubmission('outgoing-migration')).toBeDefined()
  })

  it('clears the quarantine once the submission definitively did not land', async () => {
    const quarantine = seal()
    const provider = {
      getTransactionReceipt: vi.fn(async () => ({ status: 'reverted' })),
    }

    await expect(quarantine.reconcileBeforeAttempt({
      owner: OWNER,
      chainId: 1,
      provider: provider as never,
    })).resolves.toBe('clear')
    expect(readPendingSubmission('outgoing-migration')).toBeUndefined()
  })

  it.each([
    [true, 'landed'],
    [false, 'landed-partial'],
  ] as const)('reports a landed submission (completesPlan %s) as %s', async (completesPlan, expected) => {
    const quarantine = seal({ completesPlan })
    const provider = {
      getTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    }

    await expect(quarantine.reconcileBeforeAttempt({
      owner: OWNER,
      chainId: 1,
      provider: provider as never,
    })).resolves.toBe(expected)
    // Landed is terminal — the record is released.
    expect(readPendingSubmission('outgoing-migration')).toBeUndefined()
  })

  it('reconciles a record that survived a reload', async () => {
    // No begin/track/sealFailure this session — the record was written by a
    // previous one and only storage carries it.
    writePendingSubmission('outgoing-migration', {
      kind: 'transaction',
      hash: TX_HASH,
      chainId: 1,
      owner: OWNER,
      completesPlan: true,
      submittedAt: 1_000,
    })
    const provider = {
      getTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    }

    await expect(createQuarantine().reconcileBeforeAttempt({
      owner: OWNER,
      chainId: 1,
      provider: provider as never,
    })).resolves.toBe('landed')
    expect(readPendingSubmission('outgoing-migration')).toBeUndefined()
  })
})
