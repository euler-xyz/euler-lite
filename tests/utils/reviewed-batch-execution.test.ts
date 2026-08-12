import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import { flattenBatchEntries, type TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import {
  requireReviewedBatchPreparedExecution,
  REVIEWED_BATCH_EXECUTION_CHANGED_ERROR,
} from '~/utils/reviewed-batch-execution'

const owner = '0x0000000000000000000000000000000000000001' as Address
const vault = '0x0000000000000000000000000000000000000002' as Address

const prepared = (data: Hex = '0x12345678'): TransactionPlanPrepared => ({
  __prepared: true,
  chainId: 1,
  account: owner,
  usePermit2: true,
  unlimitedApproval: false,
  plan: [{
    type: 'evcBatch',
    items: [{ targetContract: vault, onBehalfOfAccount: owner, value: 0n, data }],
  }],
})

const dynamicSignature = (bytes: string): Hex =>
  `0x12345678${'0'.repeat(62)}41${bytes}${'0'.repeat(62)}` as Hex

describe('requireReviewedBatchPreparedExecution', () => {
  it('allows only an explicitly flagged placeholder signature replacement', () => {
    const reviewed = prepared(dynamicSignature('0'.repeat(65 * 2)))
    const signed = prepared(dynamicSignature('11'.repeat(65)))

    expect(requireReviewedBatchPreparedExecution(reviewed, signed, {
      placeholderSignatureCalls: flattenBatchEntries(
        reviewed.plan[0]?.type === 'evcBatch' ? reviewed.plan[0].items : [],
      ),
    })).toBe(signed)
  })

  it('rejects a post-review approval insertion', () => {
    const reviewed = prepared()
    const candidate = prepared()
    candidate.plan.unshift({
      type: 'requiredApproval',
      token: vault,
      owner,
      spender: vault,
      amount: 1n,
      resolved: [],
    })

    expect(() => requireReviewedBatchPreparedExecution(reviewed, candidate))
      .toThrow(REVIEWED_BATCH_EXECUTION_CHANGED_ERROR)
  })

  it('rejects an operation target change outside the signature slot', () => {
    const reviewed = prepared(dynamicSignature('0'.repeat(65 * 2)))
    const changed = prepared(dynamicSignature('11'.repeat(65)))
    const batch = changed.plan[0]
    if (batch?.type === 'evcBatch' && batch.items[0] && 'targetContract' in batch.items[0]) {
      batch.items[0].targetContract = owner
    }

    expect(() => requireReviewedBatchPreparedExecution(reviewed, changed, {
      placeholderSignatureCalls: flattenBatchEntries(
        reviewed.plan[0]?.type === 'evcBatch' ? reviewed.plan[0].items : [],
      ),
    })).toThrow(REVIEWED_BATCH_EXECUTION_CHANGED_ERROR)
  })
})
