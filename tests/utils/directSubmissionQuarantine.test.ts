import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress, type Hash } from 'viem'
import type { PreparedPlanBroadcast } from '~/composables/useEulerTx'
import {
  createDirectSubmissionQuarantine,
  PENDING_SUBMISSION_ARMED_ERROR,
  PENDING_SUBMISSION_UNRESOLVED_ERROR,
} from '~/utils/directSubmissionQuarantine'
import {
  readPendingSubmission,
  resetPendingSubmissionMemoryFallback,
  writePendingSubmission,
} from '~/utils/pendingSubmissions'
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

interface WithIdOverrides {
  kind?: 'transaction' | 'proposal'
  hash?: Hash
  item?: PreparedPlanBroadcast['item']
  index?: number
  completesPlan?: boolean
}

const submitted = (overrides: WithIdOverrides = {}): PreparedPlanBroadcast => ({
  kind: overrides.kind ?? 'transaction',
  hash: overrides.hash ?? TX_HASH,
  item: overrides.item ?? 'evcBatch',
  index: overrides.index ?? 0,
  completesPlan: overrides.completesPlan ?? true,
  status: 'submitted',
})

const confirmed = (overrides: WithIdOverrides = {}): PreparedPlanBroadcast => ({
  kind: overrides.kind ?? 'transaction',
  hash: overrides.hash ?? TX_HASH,
  item: overrides.item ?? 'evcBatch',
  index: overrides.index ?? 0,
  completesPlan: overrides.completesPlan ?? true,
  status: 'confirmed',
})

const armed = (overrides: Pick<WithIdOverrides, 'item' | 'index' | 'completesPlan'> = {}): PreparedPlanBroadcast => ({
  item: overrides.item ?? 'evcBatch',
  index: overrides.index ?? 0,
  completesPlan: overrides.completesPlan ?? true,
  status: 'armed',
})

const rejected = (overrides: Pick<WithIdOverrides, 'item' | 'index' | 'completesPlan'> = {}): PreparedPlanBroadcast => ({
  item: overrides.item ?? 'evcBatch',
  index: overrides.index ?? 0,
  completesPlan: overrides.completesPlan ?? true,
  status: 'rejected',
})

const getSafeWalletProvider = vi.fn()

const createQuarantine = () => createDirectSubmissionQuarantine({
  flow: 'outgoing-migration',
  getSafeWalletProvider,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('localStorage', createMemoryStorage())
  resetPendingSubmissionMemoryFallback()
})

describe('track', () => {
  it('persists the quarantine the moment the wallet accepts an EOA submission', () => {
    const quarantine = createQuarantine()
    quarantine.begin({ owner: OWNER, chainId: 1 })
    quarantine.track(submitted())

    // The record must be durable BEFORE the executor settles: a reload
    // between the submitted callback and settlement must still find it.
    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toMatchObject({
      phase: 'submitted',
      kind: 'transaction',
      hash: TX_HASH,
      chainId: 1,
      owner: OWNER,
      completesPlan: true,
    })
    expect(quarantine.sealFailure()).toBe(true)
  })

  it('persists an armed record before an id exists', () => {
    const quarantine = createQuarantine()
    quarantine.begin({ owner: OWNER, chainId: 1 })
    quarantine.track(armed())

    // The wallet was invoked but returned nothing yet — a reload here must
    // still find the quarantine even though there is no hash.
    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toMatchObject({
      phase: 'armed',
      owner: OWNER,
      chainId: 1,
    })
    expect(quarantine.sealFailure()).toBe(true)
  })

  it('upgrades an armed record once the wallet returns the id', () => {
    const quarantine = createQuarantine()
    quarantine.begin({ owner: OWNER, chainId: 1 })
    quarantine.track(armed())
    quarantine.track(submitted())

    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toMatchObject({
      phase: 'submitted',
      hash: TX_HASH,
    })
  })

  it('releases an armed record when the wallet provably never accepted it', () => {
    const quarantine = createQuarantine()
    quarantine.begin({ owner: OWNER, chainId: 1 })
    quarantine.track(armed())
    quarantine.track(rejected())

    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toBeUndefined()
    expect(quarantine.sealFailure()).toBe(false)
  })

  it('persists the quarantine for an accepted Safe bundle proposal', () => {
    const quarantine = createQuarantine()
    quarantine.begin({ owner: OWNER, chainId: 1 })
    quarantine.track(submitted({ kind: 'proposal', hash: SAFE_TX_HASH, item: 'bundle' }))

    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toMatchObject({
      phase: 'submitted',
      kind: 'proposal',
      hash: SAFE_TX_HASH,
    })
    expect(quarantine.sealFailure()).toBe(true)
  })

  it.each(['approval', 'pluginCall'] as const)('does not quarantine an idempotent ambiguous %s', (item) => {
    const quarantine = createQuarantine()
    quarantine.begin({ owner: OWNER, chainId: 1 })
    quarantine.track(submitted({ item, completesPlan: false }))

    expect(quarantine.sealFailure()).toBe(false)
    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toBeUndefined()
  })

  it('releases the record once the submission confirmed', () => {
    const quarantine = createQuarantine()
    quarantine.begin({ owner: OWNER, chainId: 1 })
    quarantine.track(submitted())
    quarantine.track(confirmed())

    expect(quarantine.sealFailure()).toBe(false)
    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toBeUndefined()
  })

  it('fails closed to the in-memory fallback when durable storage rejects the write', async () => {
    vi.stubGlobal('localStorage', {
      ...createMemoryStorage(),
      setItem: () => {
        throw new Error('quota exceeded')
      },
    })
    const quarantine = createQuarantine()
    quarantine.begin({ owner: OWNER, chainId: 1 })
    quarantine.track(submitted())

    // Even though nothing durable was written, the retry in this session
    // must still be blocked while the outcome is unknown.
    const provider = {
      getTransactionReceipt: vi.fn(async () => {
        throw new Error('receipt not found')
      }),
    }
    await expect(createQuarantine().reconcileBeforeAttempt({
      owner: OWNER,
      chainId: 1,
      provider: provider as never,
    })).rejects.toThrow(PENDING_SUBMISSION_UNRESOLVED_ERROR)
  })

  it('does not report a quarantine when nothing was broadcast', () => {
    const quarantine = createQuarantine()
    quarantine.begin({ owner: OWNER, chainId: 1 })

    expect(quarantine.sealFailure()).toBe(false)
  })

  it('resets in-attempt tracking on the next attempt', () => {
    const quarantine = createQuarantine()
    quarantine.begin({ owner: OWNER, chainId: 1 })
    quarantine.track(submitted())
    quarantine.begin({ owner: OWNER, chainId: 1 })

    // The stale broadcast belongs to the previous attempt — but the durable
    // record it wrote survives until reconciliation resolves it.
    expect(quarantine.sealFailure()).toBe(false)
    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toBeDefined()
  })
})

describe('reconcileBeforeAttempt', () => {
  const seal = (broadcast: PreparedPlanBroadcast = submitted()) => {
    const quarantine = createQuarantine()
    quarantine.begin({ owner: OWNER, chainId: 1 })
    quarantine.track(broadcast)
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
    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toBeDefined()
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
    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toBeDefined()
  })

  it('blocks the retry forever while a record is still armed — there is no id to verify', async () => {
    const quarantine = seal(armed())
    const provider = {
      getTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    }

    await expect(quarantine.reconcileBeforeAttempt({
      owner: OWNER,
      chainId: 1,
      provider: provider as never,
    })).rejects.toThrow(PENDING_SUBMISSION_ARMED_ERROR)
    expect(provider.getTransactionReceipt).not.toHaveBeenCalled()
    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toBeDefined()
  })

  it('blocks the retry while a Safe proposal status is unknown', async () => {
    const quarantine = seal(submitted({ kind: 'proposal', hash: SAFE_TX_HASH, item: 'bundle' }))
    getSafeWalletProvider.mockResolvedValue({ request: vi.fn() })
    safeMocks.waitForSafeTransactionExecution.mockRejectedValue(
      new SafeTransactionStatusUnknownError(SAFE_TX_HASH, 'timeout'),
    )

    await expect(quarantine.reconcileBeforeAttempt({
      owner: OWNER,
      chainId: 1,
      provider: { getTransactionReceipt: vi.fn() } as never,
    })).rejects.toThrow(PENDING_SUBMISSION_UNRESOLVED_ERROR)
    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toBeDefined()
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
    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toBeUndefined()
  })

  it.each([
    [true, 'landed'],
    [false, 'landed-partial'],
  ] as const)('reports a landed submission (completesPlan %s) as %s', async (completesPlan, expected) => {
    const quarantine = seal(submitted({ completesPlan }))
    const provider = {
      getTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    }

    await expect(quarantine.reconcileBeforeAttempt({
      owner: OWNER,
      chainId: 1,
      provider: provider as never,
    })).resolves.toBe(expected)
    // Landed is terminal — the record is released.
    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toBeUndefined()
  })

  it('reconciles a record that survived a reload', async () => {
    // No begin/track/sealFailure this session — the record was written by a
    // previous one and only storage carries it.
    writePendingSubmission('outgoing-migration', {
      phase: 'submitted',
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
    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toBeUndefined()
  })

  it('blocks a fresh session after a reload that interrupted mid-flight tracking', async () => {
    // Simulate: wallet accepted, the record was written at the boundary, and
    // the page reloaded before the executor settled. A brand-new quarantine
    // instance must still block the retry from storage alone.
    const previousSession = createQuarantine()
    previousSession.begin({ owner: OWNER, chainId: 1 })
    previousSession.track(submitted())

    const provider = {
      getTransactionReceipt: vi.fn(async () => {
        throw new Error('receipt not found')
      }),
    }
    await expect(createQuarantine().reconcileBeforeAttempt({
      owner: OWNER,
      chainId: 1,
      provider: provider as never,
    })).rejects.toThrow(PENDING_SUBMISSION_UNRESOLVED_ERROR)
  })

  it('blocks a fresh session after a reload while the record is still armed', async () => {
    const previousSession = createQuarantine()
    previousSession.begin({ owner: OWNER, chainId: 1 })
    previousSession.track(armed())

    await expect(createQuarantine().reconcileBeforeAttempt({
      owner: OWNER,
      chainId: 1,
      provider: { getTransactionReceipt: vi.fn() } as never,
    })).rejects.toThrow(PENDING_SUBMISSION_ARMED_ERROR)
  })
})
