import { describe, expect, it, vi } from 'vitest'
import type { Address, Hash, Hex } from 'viem'
import type { TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import {
  getPreparedBatchFingerprint,
  loadPendingSafeBatchSubmissions,
  PENDING_SAFE_BATCH_STORAGE_KEY,
  savePendingSafeBatchSubmissions,
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

describe('pending Safe batch submissions', () => {
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
