import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address, Hash, Hex } from 'viem'
import type { TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import {
  acquirePendingSafeSubmission,
  clearPendingSafeSubmission,
  getPendingSafeSubmissionKind,
  getPreparedBatchFingerprint,
  isDefinitiveWalletRejection,
  loadPendingSafeBatchSubmissions,
  PENDING_SAFE_BATCH_STORAGE_KEY,
  SAFE_SUBMISSION_STORAGE_INVALID_ERROR,
  SAFE_SUBMISSION_RESERVATION_LOST_ERROR,
  savePendingSafeBatchSubmissions,
  updatePendingSafeSubmission,
} from '~/utils/pending-safe-batch-submission'

const account = '0x0000000000000000000000000000000000000001' as Address
const target = '0x0000000000000000000000000000000000000002' as Address
const submittedHash = `0x${'11'.repeat(32)}` as Hash

const memoryStorage = () => {
  const values = new Map<string, string>()
  return {
    getItem: vi.fn((key: string) => values.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { values.set(key, value) }),
    removeItem: vi.fn((key: string) => { values.delete(key) }),
  }
}

const serializedLocks = () => {
  let tail = Promise.resolve()
  return {
    request: vi.fn(<T>(_name: string, _options: LockOptions, callback: () => T | Promise<T>) => {
      const result = tail.then(callback, callback)
      tail = result.then(() => undefined, () => undefined)
      return result
    }),
  }
}

describe('pending Safe batch submissions', () => {
  beforeEach(() => {
    vi.stubGlobal('navigator', { locks: serializedLocks() })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('round-trips the durable reservation, hash, context, and bigint revokes', () => {
    const storage = memoryStorage()
    const pending = [{
      submittedHash,
      account,
      chainId: 1,
      batchFingerprint: '0123456789abcdef',
      errorMessage: 'Pending Safe execution',
      grantedRevokes: [{
        transaction: { to: target, data: '0x1234' as Hex, value: 7n },
        walletContext: { account, chainId: 1 },
      }],
    }]

    savePendingSafeBatchSubmissions(storage, pending)

    expect(storage.setItem).toHaveBeenCalledWith(PENDING_SAFE_BATCH_STORAGE_KEY, expect.any(String))
    expect(loadPendingSafeBatchSubmissions(storage)).toEqual(pending)
  })

  it('surfaces storage failure to the preflight caller', () => {
    const storage = memoryStorage()
    storage.setItem.mockImplementation(() => {
      throw new Error('quota')
    })

    expect(() => savePendingSafeBatchSubmissions(storage, [{
      account,
      chainId: 1,
      batchFingerprint: '0123456789abcdef',
      errorMessage: 'reserved',
      grantedRevokes: [],
    }])).toThrow('quota')
  })

  it.each([
    ['malformed JSON', () => '{'],
    ['a non-array payload', () => '{}'],
    ['an invalid record', () => '[{"account":"bad"}]'],
  ])('fails closed for %s', (_label, storedValue) => {
    const storage = memoryStorage()
    storage.getItem.mockReturnValue(storedValue())

    expect(() => loadPendingSafeBatchSubmissions(storage))
      .toThrow(SAFE_SUBMISSION_STORAGE_INVALID_ERROR)
  })

  it('fails closed when browser storage cannot be read', () => {
    const storage = memoryStorage()
    storage.getItem.mockImplementation(() => {
      throw new Error('denied')
    })

    expect(() => loadPendingSafeBatchSubmissions(storage))
      .toThrow(SAFE_SUBMISSION_STORAGE_INVALID_ERROR)
  })

  it('serializes reservation acquisition and never overwrites another owner', async () => {
    const storage = memoryStorage()
    const draft = {
      account,
      chainId: 1,
      batchFingerprint: '0123456789abcdef',
      errorMessage: 'reserved',
      grantedRevokes: [],
      submissionKind: 'operation' as const,
    }

    const first = await acquirePendingSafeSubmission(storage, draft)
    await expect(acquirePendingSafeSubmission(storage, {
      ...draft,
      batchFingerprint: 'fedcba9876543210',
    })).rejects.toThrow('hash was not retained')

    expect(loadPendingSafeBatchSubmissions(storage)).toEqual([first])
  })

  it('updates and clears only the acquired reservation owner', async () => {
    const storage = memoryStorage()
    const acquired = await acquirePendingSafeSubmission(storage, {
      account,
      chainId: 1,
      batchFingerprint: '0123456789abcdef',
      errorMessage: 'reserved',
      grantedRevokes: [],
      submissionKind: 'operation',
    })
    const submitted = await updatePendingSafeSubmission(storage, acquired, {
      ...acquired,
      submittedHash,
    })

    expect(loadPendingSafeBatchSubmissions(storage)).toEqual([submitted])
    await clearPendingSafeSubmission(storage, submitted)
    expect(loadPendingSafeBatchSubmissions(storage)).toEqual([])
  })

  it('does not mutate a reservation after another owner replaces it', async () => {
    const storage = memoryStorage()
    const acquired = await acquirePendingSafeSubmission(storage, {
      account,
      chainId: 1,
      batchFingerprint: '0123456789abcdef',
      errorMessage: 'reserved',
      grantedRevokes: [],
      submissionKind: 'operation',
    })
    const replacement = {
      ...acquired,
      batchFingerprint: 'fedcba9876543210',
      reservationId: 'other-owner',
    }
    savePendingSafeBatchSubmissions(storage, [replacement])

    await expect(updatePendingSafeSubmission(storage, acquired, {
      ...acquired,
      submittedHash,
    })).rejects.toThrow(SAFE_SUBMISSION_RESERVATION_LOST_ERROR)
    expect(loadPendingSafeBatchSubmissions(storage)).toEqual([replacement])
  })

  it('preserves direct-operation locks while treating records without a kind as batch locks', () => {
    const storage = memoryStorage()
    const operation = {
      account,
      chainId: 1,
      batchFingerprint: '0123456789abcdef',
      errorMessage: 'reserved',
      grantedRevokes: [],
      submissionKind: 'operation' as const,
    }

    savePendingSafeBatchSubmissions(storage, [operation])

    expect(getPendingSafeSubmissionKind(loadPendingSafeBatchSubmissions(storage)[0]!)).toBe('operation')
    expect(getPendingSafeSubmissionKind({ ...operation, submissionKind: undefined })).toBe('batch')
  })

  it('only classifies structured rejection codes, including nested causes, as definitive', () => {
    expect(isDefinitiveWalletRejection(Object.assign(new Error('rejected'), { code: 4001 }))).toBe(true)
    expect(isDefinitiveWalletRejection(new Error('wrapped', {
      cause: Object.assign(new Error('rejected'), { code: 'ACTION_REJECTED' }),
    }))).toBe(true)
    expect(isDefinitiveWalletRejection(new Error('User rejected the request.'))).toBe(false)
  })

  it('fingerprints the prepared account, chain, options, and exact plan', () => {
    const prepared = {
      __prepared: true,
      account,
      chainId: 1,
      usePermit2: true,
      unlimitedApproval: false,
      plan: [],
    } as TransactionPlanPrepared
    const changed = { ...prepared, chainId: 10 }

    expect(getPreparedBatchFingerprint(prepared)).toHaveLength(16)
    expect(getPreparedBatchFingerprint(prepared)).not.toBe(getPreparedBatchFingerprint(changed))
  })
})
