import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getAddress, type Hash } from 'viem'
import {
  clearPendingSubmission,
  readPendingSubmission,
  resolvePendingSubmissionOutcome,
  writePendingSubmission,
  type PendingSubmissionRecord,
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

const record = (overrides: Partial<PendingSubmissionRecord> = {}): PendingSubmissionRecord => ({
  kind: 'transaction',
  hash: TX_HASH,
  chainId: 1,
  owner: OWNER,
  completesPlan: true,
  submittedAt: 1_000,
  ...overrides,
})

beforeEach(() => {
  vi.clearAllMocks()
  vi.stubGlobal('localStorage', createMemoryStorage())
})

describe('pending submission storage', () => {
  it('round-trips a record through storage', () => {
    writePendingSubmission('batch', record({ refreshExternalPositions: true }))

    expect(readPendingSubmission('batch')).toEqual(record({ refreshExternalPositions: true }))
    // Flows are isolated: the batch record must not leak into direct flows.
    expect(readPendingSubmission('outgoing-migration')).toBeUndefined()
  })

  it('clears a stored record', () => {
    writePendingSubmission('outgoing-migration', record())

    clearPendingSubmission('outgoing-migration')

    expect(readPendingSubmission('outgoing-migration')).toBeUndefined()
  })

  it('normalizes the stored owner to checksum form', () => {
    localStorage.setItem('euler_pending_submission:batch', JSON.stringify({
      ...record(),
      owner: OWNER.toLowerCase(),
    }))

    expect(readPendingSubmission('batch')?.owner).toBe(OWNER)
  })

  it.each([
    ['unparseable JSON', 'not json'],
    ['wrong kind', JSON.stringify({ ...record(), kind: 'other' })],
    ['malformed hash', JSON.stringify({ ...record(), hash: '0x1234' })],
    ['malformed owner', JSON.stringify({ ...record(), owner: '0xnope' })],
    ['non-boolean completesPlan', JSON.stringify({ ...record(), completesPlan: 'yes' })],
    ['non-numeric submittedAt', JSON.stringify({ ...record(), submittedAt: 'now' })],
    ['non-positive chainId', JSON.stringify({ ...record(), chainId: 0 })],
  ])('drops a corrupt record (%s) instead of blocking the flow forever', (_label, raw) => {
    localStorage.setItem('euler_pending_submission:batch', raw)

    expect(readPendingSubmission('batch')).toBeUndefined()
    // The corrupt payload was removed, not left to fail on every read.
    expect(localStorage.getItem('euler_pending_submission:batch')).toBeNull()
  })

  it('degrades to no-ops without browser storage', () => {
    vi.stubGlobal('localStorage', undefined)

    expect(() => writePendingSubmission('batch', record())).not.toThrow()
    expect(readPendingSubmission('batch')).toBeUndefined()
    expect(() => clearPendingSubmission('batch')).not.toThrow()
  })
})

describe('resolvePendingSubmissionOutcome', () => {
  const getSafeWalletProvider = vi.fn()

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
