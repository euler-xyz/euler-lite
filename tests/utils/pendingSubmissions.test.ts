import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress, type Hash } from 'viem'
import {
  clearPendingSubmission,
  listPendingSubmissions,
  readPendingSubmission,
  resetPendingSubmissionMemoryFallback,
  resolvePendingSubmissionOutcome,
  walletNeverAcceptedSubmission,
  writePendingSubmission,
  type PendingSubmissionRecord,
  type SubmittedPendingSubmission,
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
const BATCH_KEY = `euler_pending_submission:batch:1:${OWNER}`

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

const record = (overrides: Partial<SubmittedPendingSubmission> = {}): PendingSubmissionRecord => ({
  phase: 'submitted',
  kind: 'transaction',
  hash: TX_HASH,
  chainId: 1,
  owner: OWNER,
  completesPlan: true,
  submittedAt: 1_000,
  ...overrides,
})

const armedRecord = (): PendingSubmissionRecord => ({
  phase: 'armed',
  chainId: 1,
  owner: OWNER,
  completesPlan: true,
  submittedAt: 1_000,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('localStorage', createMemoryStorage())
  resetPendingSubmissionMemoryFallback()
})

describe('pending submission storage', () => {
  it('round-trips a record through storage', () => {
    writePendingSubmission('batch', record({ refreshExternalPositions: true }))

    expect(readPendingSubmission('batch', OWNER, 1)).toEqual(record({ refreshExternalPositions: true }))
    // Flows are isolated: the batch record must not leak into direct flows.
    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toBeUndefined()
  })

  it('round-trips an armed record without an id', () => {
    writePendingSubmission('batch', armedRecord())

    expect(readPendingSubmission('batch', OWNER, 1)).toEqual(armedRecord())
  })

  it('keys records per wallet and chain so one wallet cannot overwrite another', () => {
    writePendingSubmission('batch', record())
    writePendingSubmission('batch', record({ owner: OTHER_OWNER, hash: SAFE_TX_HASH }))
    writePendingSubmission('batch', record({ chainId: 8453 }))

    // All three coexist and each is independently readable/reconcilable.
    expect(readPendingSubmission('batch', OWNER, 1)).toEqual(record())
    expect(readPendingSubmission('batch', OTHER_OWNER, 1)).toEqual(record({ owner: OTHER_OWNER, hash: SAFE_TX_HASH }))
    expect(readPendingSubmission('batch', OWNER, 8453)).toEqual(record({ chainId: 8453 }))
    expect(listPendingSubmissions('batch')).toHaveLength(3)

    // Clearing one wallet's record leaves the others quarantined.
    clearPendingSubmission('batch', OWNER, 1)
    expect(readPendingSubmission('batch', OWNER, 1)).toBeUndefined()
    expect(readPendingSubmission('batch', OTHER_OWNER, 1)).toBeDefined()
    expect(readPendingSubmission('batch', OWNER, 8453)).toBeDefined()
  })

  it('clears a stored record', () => {
    writePendingSubmission('outgoing-migration', record())

    clearPendingSubmission('outgoing-migration', OWNER, 1)

    expect(readPendingSubmission('outgoing-migration', OWNER, 1)).toBeUndefined()
  })

  it('normalizes owners to checksum form for keying and reading', () => {
    writePendingSubmission('batch', record())

    expect(readPendingSubmission('batch', OWNER.toLowerCase() as typeof OWNER, 1)).toEqual(record())
  })

  it('normalizes the stored owner to checksum form', () => {
    localStorage.setItem(BATCH_KEY, JSON.stringify({
      ...record(),
      owner: OWNER.toLowerCase(),
    }))

    expect(readPendingSubmission('batch', OWNER, 1)?.owner).toBe(OWNER)
  })

  it.each([
    ['unparseable JSON', 'not json'],
    ['wrong phase', JSON.stringify({ ...record(), phase: 'other' })],
    ['missing phase', JSON.stringify({ ...record(), phase: undefined })],
    ['wrong kind', JSON.stringify({ ...record(), kind: 'other' })],
    ['malformed hash', JSON.stringify({ ...record(), hash: '0x1234' })],
    ['malformed owner', JSON.stringify({ ...record(), owner: '0xnope' })],
    ['non-boolean completesPlan', JSON.stringify({ ...record(), completesPlan: 'yes' })],
    ['non-numeric submittedAt', JSON.stringify({ ...record(), submittedAt: 'now' })],
    ['non-positive chainId', JSON.stringify({ ...record(), chainId: 0 })],
  ])('drops a corrupt record (%s) instead of blocking the flow forever', (_label, raw) => {
    localStorage.setItem(BATCH_KEY, raw)

    expect(readPendingSubmission('batch', OWNER, 1)).toBeUndefined()
    // The corrupt payload was removed, not left to fail on every read.
    expect(localStorage.getItem(BATCH_KEY)).toBeNull()
  })

  it('drops a record whose content disagrees with its storage key', () => {
    localStorage.setItem(BATCH_KEY, JSON.stringify(record({ owner: OTHER_OWNER })))

    expect(readPendingSubmission('batch', OWNER, 1)).toBeUndefined()
    expect(localStorage.getItem(BATCH_KEY)).toBeNull()
  })

  it('fails closed to the in-memory fallback without browser storage', () => {
    vi.stubGlobal('localStorage', undefined)

    // No durable storage exists, but the quarantine must still block this
    // session's retries rather than silently degrade to "no quarantine".
    writePendingSubmission('batch', record())
    expect(readPendingSubmission('batch', OWNER, 1)).toEqual(record())
    expect(listPendingSubmissions('batch')).toEqual([record()])

    clearPendingSubmission('batch', OWNER, 1)
    expect(readPendingSubmission('batch', OWNER, 1)).toBeUndefined()
  })

  it('fails closed to the in-memory fallback when the storage write throws', () => {
    const storage = createMemoryStorage()
    vi.stubGlobal('localStorage', {
      ...storage,
      setItem: () => {
        throw new Error('quota exceeded')
      },
    })

    writePendingSubmission('batch', record())

    expect(readPendingSubmission('batch', OWNER, 1)).toEqual(record())
  })

  it('fails closed to the in-memory fallback when the storage write does not stick', () => {
    const storage = createMemoryStorage()
    vi.stubGlobal('localStorage', {
      ...storage,
      // A lying storage: accepts the write, returns nothing on read-back.
      setItem: () => {},
      getItem: () => null,
      get length() {
        return 0
      },
    })

    writePendingSubmission('batch', record())

    expect(readPendingSubmission('batch', OWNER, 1)).toEqual(record())
    expect(listPendingSubmissions('batch')).toEqual([record()])
  })

  it('lists records across storage and the in-memory fallback together', () => {
    const storage = globalThis.localStorage
    writePendingSubmission('batch', record())
    vi.stubGlobal('localStorage', undefined)
    writePendingSubmission('batch', record({ owner: OTHER_OWNER }))
    vi.stubGlobal('localStorage', storage)

    expect(listPendingSubmissions('batch')).toEqual(expect.arrayContaining([
      record(),
      record({ owner: OTHER_OWNER }),
    ]))
    expect(listPendingSubmissions('batch')).toHaveLength(2)
  })
})

describe('walletNeverAcceptedSubmission', () => {
  it.each([
    ['EIP-1193 user rejection code', { code: 4001 }],
    ['viem user rejection', { name: 'UserRejectedRequestError' }],
    ['connector not connected', { name: 'ConnectorNotConnectedError' }],
    ['nested cause chain', new Error('outer', { cause: { cause: { code: 4001 } } })],
  ])('recognizes a provable non-acceptance (%s)', (_label, error) => {
    expect(walletNeverAcceptedSubmission(error)).toBe(true)
  })

  it.each([
    ['plain error', new Error('Failed to fetch')],
    ['timeout-ish error', { name: 'TimeoutError', code: -32603 }],
    ['malformed response', new Error('Safe wallet returned an unexpected call bundle id.')],
    ['nothing', undefined],
  ])('treats anything else as possibly accepted (%s)', (_label, error) => {
    expect(walletNeverAcceptedSubmission(error)).toBe(false)
  })
})

describe('resolvePendingSubmissionOutcome', () => {
  const getSafeWalletProvider = vi.fn()

  it('always stays unknown for an armed record — there is no id to verify', async () => {
    const provider = {
      getTransactionReceipt: vi.fn(async () => ({ status: 'success' })),
    }

    await expect(resolvePendingSubmissionOutcome(armedRecord(), {
      provider: provider as never,
      getSafeWalletProvider,
    })).resolves.toBe('unknown')
    expect(provider.getTransactionReceipt).not.toHaveBeenCalled()
  })

  it('stays unknown without a provider to verify against', async () => {
    await expect(resolvePendingSubmissionOutcome(record(), {
      provider: undefined,
      getSafeWalletProvider,
    })).resolves.toBe('unknown')
  })

  it.each([
    ['success', 'landed'],
    ['reverted', 'not-landed'],
  ] as const)('maps a %s transaction receipt to %s', async (status, expected) => {
    const provider = {
      getTransactionReceipt: vi.fn(async () => ({ status })),
    }

    await expect(resolvePendingSubmissionOutcome(record(), {
      provider: provider as never,
      getSafeWalletProvider,
    })).resolves.toBe(expected)
    expect(provider.getTransactionReceipt).toHaveBeenCalledWith({ hash: TX_HASH })
  })

  it('stays unknown when the transaction has no receipt yet', async () => {
    // No receipt covers both a pending transaction and a dropped one that a
    // mempool copy could still re-broadcast — neither is a terminal verdict.
    const provider = {
      getTransactionReceipt: vi.fn(async () => {
        throw new Error('receipt not found')
      }),
    }

    await expect(resolvePendingSubmissionOutcome(record(), {
      provider: provider as never,
      getSafeWalletProvider,
    })).resolves.toBe('unknown')
  })

  const proposal = record({ kind: 'proposal', hash: SAFE_TX_HASH })
  const provider = { getTransactionReceipt: vi.fn() }

  it('stays unknown when no Safe provider can be acquired', async () => {
    getSafeWalletProvider.mockResolvedValueOnce(undefined)

    await expect(resolvePendingSubmissionOutcome(proposal, {
      provider: provider as never,
      getSafeWalletProvider,
    })).resolves.toBe('unknown')
    expect(safeMocks.waitForSafeTransactionExecution).not.toHaveBeenCalled()
  })

  it('stays unknown when Safe provider acquisition throws', async () => {
    getSafeWalletProvider.mockRejectedValueOnce(new Error('no session'))

    await expect(resolvePendingSubmissionOutcome(proposal, {
      provider: provider as never,
      getSafeWalletProvider,
    })).resolves.toBe('unknown')
  })

  it.each([
    ['success', 'landed'],
    ['reverted', 'not-landed'],
  ] as const)('maps a %s Safe execution receipt to %s', async (status, expected) => {
    getSafeWalletProvider.mockResolvedValueOnce({ request: vi.fn() })
    safeMocks.waitForSafeTransactionExecution.mockResolvedValueOnce({
      hash: SAFE_TX_HASH,
      receipt: { status },
    })

    await expect(resolvePendingSubmissionOutcome(proposal, {
      provider: provider as never,
      getSafeWalletProvider,
      safeStatusTimeoutMs: 5_000,
    })).resolves.toBe(expected)
    expect(safeMocks.waitForSafeTransactionExecution).toHaveBeenCalledWith(expect.objectContaining({
      submittedHash: SAFE_TX_HASH,
      timeoutMs: 5_000,
    }))
  })

  it.each([
    ['Safe transaction was cancelled', 'not-landed'],
    ['Safe transaction failed', 'not-landed'],
    ['network exploded', 'unknown'],
  ] as const)('maps a "%s" Safe status error to %s', async (message, expected) => {
    getSafeWalletProvider.mockResolvedValueOnce({ request: vi.fn() })
    safeMocks.waitForSafeTransactionExecution.mockRejectedValueOnce(new Error(message))

    await expect(resolvePendingSubmissionOutcome(proposal, {
      provider: provider as never,
      getSafeWalletProvider,
    })).resolves.toBe(expected)
  })

  it('stays unknown while the Safe status itself is unknown', async () => {
    getSafeWalletProvider.mockResolvedValueOnce({ request: vi.fn() })
    safeMocks.waitForSafeTransactionExecution.mockRejectedValueOnce(
      new SafeTransactionStatusUnknownError(SAFE_TX_HASH, 'timeout'),
    )

    await expect(resolvePendingSubmissionOutcome(proposal, {
      provider: provider as never,
      getSafeWalletProvider,
    })).resolves.toBe('unknown')
  })
})
