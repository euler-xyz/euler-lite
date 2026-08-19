import { describe, expect, it } from 'vitest'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { buildBatchReviewCalldata } from '~/utils/batchReviewCalldata'

const BEFORE = '0x1000000000000000000000000000000000000001' as Address
const PLUGIN = '0x2000000000000000000000000000000000000002' as Address
const TOKEN = '0x3000000000000000000000000000000000000003' as Address
const EVC = '0x4000000000000000000000000000000000000004' as Address
const AFTER = '0x5000000000000000000000000000000000000005' as Address
const ACCOUNT = '0x6000000000000000000000000000000000000006' as Address
const BATCH_TARGET = '0x7000000000000000000000000000000000000007' as Address

const pingAbi = [{
  type: 'function',
  name: 'ping',
  inputs: [],
  outputs: [],
  stateMutability: 'payable',
}] as const

describe('buildBatchReviewCalldata', () => {
  it('preserves the exact before, prepared plugin/approval/core, after vector', () => {
    const pluginData = encodeFunctionData({ abi: pingAbi, functionName: 'ping' })
    const plan = [{
      type: 'contractCall',
      chainId: 1,
      to: PLUGIN,
      abi: pingAbi,
      functionName: 'ping',
      args: [],
      value: 7n,
    }, {
      type: 'requiredApproval',
      token: TOKEN,
      owner: ACCOUNT,
      spender: BATCH_TARGET,
      amount: 9n,
      resolved: [{
        type: 'approve',
        token: TOKEN,
        owner: ACCOUNT,
        spender: BATCH_TARGET,
        amount: 9n,
        data: '0xapprove' as Hex,
      }],
    }, {
      type: 'evcBatch',
      items: [{
        targetContract: BATCH_TARGET,
        onBehalfOfAccount: ACCOUNT,
        value: 11n,
        data: '0xcore' as Hex,
      }],
    }] as unknown as TransactionPlan

    const calldata = buildBatchReviewCalldata({
      plan,
      before: [{ to: BEFORE, data: '0xbefore' as Hex, value: 3n }],
      after: [{ to: AFTER, data: '0xafter' as Hex }],
      sdk: {
        deploymentService: {
          getDeployment: () => ({ addresses: { coreAddrs: { evc: EVC } } }),
        },
        executionService: { encodeBatch: () => '0xbatch' as Hex },
      },
      chainId: 1,
    })

    expect(calldata).toEqual([
      { to: BEFORE, data: '0xbefore', value: '3' },
      { to: PLUGIN, data: pluginData, value: '7' },
      { to: TOKEN, data: '0xapprove', value: '0' },
      { to: EVC, data: '0xbatch', value: '11' },
      { to: AFTER, data: '0xafter', value: '0' },
    ])
  })
})
