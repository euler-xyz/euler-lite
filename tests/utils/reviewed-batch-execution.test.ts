import { describe, expect, it } from 'vitest'
import { encodeFunctionData, parseAbi, type Address, type Hex } from 'viem'
import { flattenBatchEntries, type TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import {
  requireReviewedBatchPreparedExecution,
  REVIEWED_BATCH_EXECUTION_CHANGED_ERROR,
} from '~/utils/reviewed-batch-execution'
import { PYTH_ABI } from '~/abis/pyth'

const owner = '0x0000000000000000000000000000000000000001' as Address
const vault = '0x0000000000000000000000000000000000000002' as Address
const spender = '0x0000000000000000000000000000000000000003' as Address
const pyth = '0x4305FB66699C3B2702D4d05CF36551390A4c69C6' as Address
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
const unrelatedDynamicAbi = parseAbi(['function submit(bytes payload)'])

const prepared = (
  data: Hex = '0x12345678',
  options: { target?: Address, value?: bigint, chainId?: number } = {},
): TransactionPlanPrepared => ({
  __prepared: true,
  chainId: options.chainId ?? 1,
  account: owner,
  usePermit2: true,
  unlimitedApproval: false,
  plan: [{
    type: 'evcBatch',
    items: [{
      targetContract: options.target ?? vault,
      onBehalfOfAccount: owner,
      value: options.value ?? 0n,
      data,
    }],
  }],
})

const unrelatedDynamicCall = (payload: Hex): Hex => encodeFunctionData({
  abi: unrelatedDynamicAbi,
  functionName: 'submit',
  args: [payload],
})

describe('requireReviewedBatchPreparedExecution', () => {
  const expectAllowedSignatureReplacement = (reviewed: TransactionPlanPrepared, signed: TransactionPlanPrepared) => {
    expect(requireReviewedBatchPreparedExecution(reviewed, signed, {
      placeholderSignatureCalls: flattenBatchEntries(
        reviewed.plan[0]?.type === 'evcBatch' ? reviewed.plan[0].items : [],
      ),
    })).toBe(signed)
  }

  it('rejects an unrelated dynamic bytes replacement even when its call is flagged', () => {
    const reviewed = prepared(unrelatedDynamicCall(`0x${'00'.repeat(65)}`))
    const signed = prepared(unrelatedDynamicCall(`0x${'11'.repeat(65)}`))

    expect(() => expectAllowedSignatureReplacement(reviewed, signed))
      .toThrow(REVIEWED_BATCH_EXECUTION_CHANGED_ERROR)
  })

  it.each([
    ['permit', 0],
    ['permit', 27],
    ['delegationWithSig', 0],
    ['delegationWithSig', 27],
  ] as const)(
    'allows an explicitly flagged Aave %s (v=%i,r=0,s=0) signature replacement',
    (functionName, placeholderV) => {
      const args = [owner, spender, 123n, 456n, placeholderV, bytes32Zero, bytes32Zero] as const
      const signedArgs = [owner, spender, 123n, 456n, 27, bytes32SignedR, bytes32SignedS] as const
      const reviewed = prepared(encodeFunctionData({ abi: aaveAuthorizationAbi, functionName, args }))
      const signed = prepared(encodeFunctionData({ abi: aaveAuthorizationAbi, functionName, args: signedArgs }))

      expectAllowedSignatureReplacement(reviewed, signed)
    },
  )

  it.each([0, 27] as const)('allows an explicitly flagged Morpho (v=%i,r=0,s=0) signature replacement', (placeholderV) => {
    const authorization = { authorizer: owner, authorized: spender, isAuthorized: true, nonce: 1n, deadline: 456n }
    const reviewed = prepared(encodeFunctionData({
      abi: morphoAuthorizationAbi,
      functionName: 'setAuthorizationWithSig',
      args: [authorization, { v: placeholderV, r: bytes32Zero, s: bytes32Zero }],
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

  it('allows only canonical fresh Pyth data and a bounded fee on the official chain target', () => {
    const reviewed = prepared(encodeFunctionData({
      abi: PYTH_ABI,
      functionName: 'updatePriceFeeds',
      args: [['0x0102']],
    }), { target: pyth, value: 1n })
    const candidate = prepared(encodeFunctionData({
      abi: PYTH_ABI,
      functionName: 'updatePriceFeeds',
      args: [['0x0304']],
    }), { target: pyth, value: 2n })

    expect(requireReviewedBatchPreparedExecution(reviewed, candidate)).toBe(candidate)
  })

  it('rejects a fresh-looking Pyth call to an arbitrary target', () => {
    const reviewed = prepared(encodeFunctionData({
      abi: PYTH_ABI,
      functionName: 'updatePriceFeeds',
      args: [['0x0102']],
    }), { target: vault, value: 1n })
    const candidate = prepared(encodeFunctionData({
      abi: PYTH_ABI,
      functionName: 'updatePriceFeeds',
      args: [['0x0304']],
    }), { target: vault, value: 2n })

    expect(() => requireReviewedBatchPreparedExecution(reviewed, candidate))
      .toThrow(REVIEWED_BATCH_EXECUTION_CHANGED_ERROR)
  })

  it('rejects an excessive fresh Pyth fee', () => {
    const reviewed = prepared(encodeFunctionData({
      abi: PYTH_ABI,
      functionName: 'updatePriceFeeds',
      args: [['0x0102']],
    }), { target: pyth, value: 1n })
    const candidate = prepared(encodeFunctionData({
      abi: PYTH_ABI,
      functionName: 'updatePriceFeeds',
      args: [['0x0304']],
    }), { target: pyth, value: 10n ** 16n + 1n })

    expect(() => requireReviewedBatchPreparedExecution(reviewed, candidate))
      .toThrow(REVIEWED_BATCH_EXECUTION_CHANGED_ERROR)
  })

  it('rejects an operation target change outside the signature slot', () => {
    const reviewed = prepared(encodeFunctionData({
      abi: aaveAuthorizationAbi,
      functionName: 'permit',
      args: [owner, spender, 123n, 456n, 27, bytes32Zero, bytes32Zero],
    }))
    const changed = prepared(encodeFunctionData({
      abi: aaveAuthorizationAbi,
      functionName: 'permit',
      args: [owner, spender, 123n, 456n, 28, bytes32SignedR, bytes32SignedS],
    }))
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
