import { describe, expect, it } from 'vitest'
import type { Address, Hash, Hex } from 'viem'
import {
  getPreparedBatchFingerprint,
  loadPendingSafeBatchSubmissions,
  PENDING_SAFE_BATCH_STORAGE_KEY,
  savePendingSafeBatchSubmissions,
} from '~/utils/pending-safe-batch-submission'

const owner = '0x0000000000000000000000000000000000000001' as Address
const submittedHash = `0x${'12'.repeat(32)}` as Hash

const memoryStorage = () => {
  const values = new Map<string, string>()
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    removeItem: (key: string) => values.delete(key),
  }
}

describe('pending Safe batch persistence', () => {
  it('round-trips the submitted hash, context, fingerprint, and revoke data', () => {
    const storage = memoryStorage()
    savePendingSafeBatchSubmissions(storage, [{
      submittedHash,
      submissionKind: 'prerequisite',
      account: owner,
      chainId: 1,
      batchFingerprint: '0123456789abcdef',
      batchPlan: [{ type: 'evcBatch', items: [] }],
      errorMessage: 'status unknown',
      refreshExternalMigrationPositions: true,
      grantedRevokes: [{
        transaction: { to: owner, data: '0x1234' as Hex, value: 1n },
        walletContext: { account: owner, chainId: 1 },
      }],
    }])

    expect(loadPendingSafeBatchSubmissions(storage)).toEqual([{
      submittedHash,
      submissionKind: 'prerequisite',
      account: owner,
      chainId: 1,
      batchFingerprint: '0123456789abcdef',
      batchPlan: [{ type: 'evcBatch', items: [] }],
      errorMessage: 'status unknown',
      refreshExternalMigrationPositions: true,
      grantedRevokes: [{
        transaction: { to: owner, data: '0x1234', value: 1n },
        walletContext: { account: owner, chainId: 1 },
      }],
    }])
  })

  it('round-trips a pre-submission reservation without inventing a Safe hash', () => {
    const storage = memoryStorage()
    savePendingSafeBatchSubmissions(storage, [{
      account: owner,
      chainId: 1,
      batchFingerprint: 'fedcba9876543210',
      batchPlan: [{ type: 'evcBatch', items: [] }],
      errorMessage: 'reserved before Safe submission',
      refreshExternalMigrationPositions: false,
      grantedRevokes: [],
    }])

    expect(loadPendingSafeBatchSubmissions(storage)).toEqual([{
      account: owner,
      chainId: 1,
      batchFingerprint: 'fedcba9876543210',
      batchPlan: [{ type: 'evcBatch', items: [] }],
      errorMessage: 'reserved before Safe submission',
      refreshExternalMigrationPositions: false,
      grantedRevokes: [],
    }])
  })

  it('keeps legacy submitted locks without a kind compatible', () => {
    const storage = memoryStorage()
    savePendingSafeBatchSubmissions(storage, [{
      submittedHash,
      account: owner,
      chainId: 1,
      batchFingerprint: '0123456789abcdef',
      batchPlan: [],
      errorMessage: 'legacy batch status unknown',
      refreshExternalMigrationPositions: false,
      grantedRevokes: [],
    }])

    expect(loadPendingSafeBatchSubmissions(storage)[0]?.submissionKind).toBeUndefined()
  })

  it.each([
    ['malformed JSON', '{'],
    ['a non-array value', '{}'],
    ['an invalid record in the array', '[{"account":"bad"}]'],
    ['an empty stored value', ''],
  ])('fails closed for %s', (_label, stored) => {
    const storage = memoryStorage()
    storage.setItem(PENDING_SAFE_BATCH_STORAGE_KEY, stored)

    expect(() => loadPendingSafeBatchSubmissions(storage)).toThrow(/storage is (unreadable|invalid)/)
  })

  it('fails closed when the storage read throws', () => {
    const storage = {
      getItem: () => { throw new Error('storage temporarily unavailable') },
      setItem: () => {},
      removeItem: () => {},
    }

    expect(() => loadPendingSafeBatchSubmissions(storage)).toThrow('storage is unreadable')
  })

  it('fingerprints the full prepared batch envelope', () => {
    const base = {
      __prepared: true as const,
      chainId: 1,
      account: owner,
      usePermit2: true,
      unlimitedApproval: false,
      plan: [],
    }
    const changed = { ...base, chainId: 8453 }

    expect(getPreparedBatchFingerprint(base)).toHaveLength(16)
    expect(getPreparedBatchFingerprint(base)).not.toBe(getPreparedBatchFingerprint(changed))
  })
})
