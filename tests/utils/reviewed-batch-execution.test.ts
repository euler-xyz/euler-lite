import { describe, expect, it } from 'vitest'
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { flattenBatchEntries, type TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import {
  requireReviewedBatchPreparedExecution,
  REVIEWED_BATCH_EXECUTION_CHANGED_ERROR,
} from '~/utils/reviewed-batch-execution'

const owner = '0x0000000000000000000000000000000000000001' as Address
const vault = '0x0000000000000000000000000000000000000002' as Address
const spender = '0x0000000000000000000000000000000000000003' as Address
const bytes32Zero = `0x${'00'.repeat(32)}` as Hex
const bytes32SignedR = `0x${'11'.repeat(32)}` as Hex
const bytes32SignedS = `0x${'22'.repeat(32)}` as Hex
const aaveAuthorizationAbi = parseAbi([
  'function permit(address owner,address spender,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
  'function delegationWithSig(address delegator,address delegatee,uint256 value,uint256 deadline,uint8 v,bytes32 r,bytes32 s)',
])
const morphoAuthorizationAbi = parseAbi([
  'function setAuthorizationWithSig((address authorizer,address authorized,bool isAuthorized,uint256 nonce,uint256 deadline) authorization,(uint8 v,bytes32 r,bytes32 s) signature)',
])

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
  const expectAllowedSignatureReplacement = (reviewed: TransactionPlanPrepared, signed: TransactionPlanPrepared) => {
    expect(requireReviewedBatchPreparedExecution(reviewed, signed, {
      placeholderSignatureCalls: flattenBatchEntries(
        reviewed.plan[0]?.type === 'evcBatch' ? reviewed.plan[0].items : [],
      ),
    })).toBe(signed)
  }

  it('allows only an explicitly flagged placeholder signature replacement', () => {
    const reviewed = prepared(dynamicSignature('0'.repeat(65 * 2)))
    const signed = prepared(dynamicSignature('11'.repeat(65)))

    expectAllowedSignatureReplacement(reviewed, signed)
  })

  it.each(['permit', 'delegationWithSig'] as const)(
    'allows an explicitly flagged Aave %s (v,r,s) signature replacement',
    (functionName) => {
      const args = [owner, spender, 123n, 456n, 0, bytes32Zero, bytes32Zero] as const
      const signedArgs = [owner, spender, 123n, 456n, 27, bytes32SignedR, bytes32SignedS] as const
      const reviewed = prepared(encodeFunctionData({ abi: aaveAuthorizationAbi, functionName, args }))
      const signed = prepared(encodeFunctionData({ abi: aaveAuthorizationAbi, functionName, args: signedArgs }))

      expectAllowedSignatureReplacement(reviewed, signed)
    },
  )

  it('allows an explicitly flagged Morpho (v,r,s) signature replacement', () => {
    const authorization = { authorizer: owner, authorized: spender, isAuthorized: true, nonce: 1n, deadline: 456n }
    const reviewed = prepared(encodeFunctionData({
      abi: morphoAuthorizationAbi,
      functionName: 'setAuthorizationWithSig',
      args: [authorization, { v: 0, r: bytes32Zero, s: bytes32Zero }],
    }))
    const signed = prepared(encodeFunctionData({
      abi: morphoAuthorizationAbi,
      functionName: 'setAuthorizationWithSig',
      args: [authorization, { v: 28, r: bytes32SignedR, s: bytes32SignedS }],
    }))

    expectAllowedSignatureReplacement(reviewed, signed)
  })

  it('still rejects a changed Aave authorization amount while masking (v,r,s)', () => {
    const reviewed = prepared(encodeFunctionData({
      abi: aaveAuthorizationAbi,
      functionName: 'permit',
      args: [owner, spender, 123n, 456n, 0, bytes32Zero, bytes32Zero],
    }))
    const changed = prepared(encodeFunctionData({
      abi: aaveAuthorizationAbi,
      functionName: 'permit',
      args: [owner, spender, 124n, 456n, 27, bytes32SignedR, bytes32SignedS],
    }))

    expect(() => expectAllowedSignatureReplacement(reviewed, changed))
      .toThrow(REVIEWED_BATCH_EXECUTION_CHANGED_ERROR)
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
