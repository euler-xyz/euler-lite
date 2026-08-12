import { describe, expect, it } from 'vitest'
import type { TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import {
  requirePythOnlyPreparedRefresh,
  requireReviewedExecution,
  REVIEWED_EXECUTION_CHANGED_ERROR,
  REVIEWED_EXECUTION_UNAVAILABLE_ERROR,
} from '~/utils/reviewed-execution'

const pyth = '0x0000000000000000000000000000000000000001' as Address
const owner = '0x0000000000000000000000000000000000000002' as Address
const vault = '0x0000000000000000000000000000000000000003' as Address
const pythAbi = [{
  type: 'function',
  name: 'updatePriceFeeds',
  inputs: [{ name: 'updateData', type: 'bytes[]' }],
  outputs: [],
  stateMutability: 'payable',
}] as const

const prepared = (update: Hex, operationData: Hex = '0x12345678'): TransactionPlanPrepared => ({
  __prepared: true,
  chainId: 1,
  account: owner,
  usePermit2: true,
  unlimitedApproval: false,
  plan: [{
    type: 'evcBatch',
    items: [{
      targetContract: pyth,
      onBehalfOfAccount: owner,
      value: 1n,
      data: encodeFunctionData({ abi: pythAbi, functionName: 'updatePriceFeeds', args: [[update]] }),
    }, {
      targetContract: vault,
      onBehalfOfAccount: owner,
      value: 0n,
      data: operationData,
    }],
  }],
})

describe('requireReviewedExecution', () => {
  it('returns the exact reviewed artifact by identity', () => {
    const reviewed = { plan: [], chainId: 1 } as unknown as TransactionPlanPrepared

    expect(requireReviewedExecution(reviewed)).toBe(reviewed)
  })

  it('fails closed when review did not provide an executable artifact', () => {
    expect(() => requireReviewedExecution(undefined)).toThrow(REVIEWED_EXECUTION_UNAVAILABLE_ERROR)
  })
})

describe('requirePythOnlyPreparedRefresh', () => {
  it('accepts fresh Pyth bytes and fees when the reviewed operations are unchanged', () => {
    const reviewed = prepared('0x01')
    const refreshed = prepared('0x02')
    const batch = refreshed.plan[0]
    if (batch?.type === 'evcBatch' && !('type' in batch.items[0]!)) batch.items[0]!.value = 2n

    expect(requirePythOnlyPreparedRefresh(reviewed, refreshed)).toBe(refreshed)
  })

  it('rejects a changed non-Pyth operation', () => {
    expect(() => requirePythOnlyPreparedRefresh(prepared('0x01'), prepared('0x02', '0x87654321')))
      .toThrow(REVIEWED_EXECUTION_CHANGED_ERROR)
  })

  it('rejects a changed prepared account', () => {
    const refreshed = prepared('0x02')
    refreshed.account = vault

    expect(() => requirePythOnlyPreparedRefresh(prepared('0x01'), refreshed))
      .toThrow(REVIEWED_EXECUTION_CHANGED_ERROR)
  })

  it('rejects a missing Pyth update', () => {
    const refreshed = prepared('0x02')
    const batch = refreshed.plan[0]
    if (batch?.type === 'evcBatch') batch.items.shift()

    expect(() => requirePythOnlyPreparedRefresh(prepared('0x01'), refreshed))
      .toThrow(REVIEWED_EXECUTION_CHANGED_ERROR)
  })
})
