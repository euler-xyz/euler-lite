import { describe, expect, it } from 'vitest'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import {
  isPlanBundleable,
  PlanNotBundleableError,
  transactionPlanToCalls,
  type PlanEncodingSdk,
} from '~/utils/transaction-plan-calls'

const TOKEN = '0x00000000000000000000000000000000000000t0'.replace('t0', 'a0') as `0x${string}`
const OWNER = '0x00000000000000000000000000000000000000a1' as `0x${string}`
const SPENDER = '0x00000000000000000000000000000000000000a2' as `0x${string}`
const EVC = '0x00000000000000000000000000000000000000e0' as `0x${string}`
const APPROVE_DATA = '0x095ea7b3aa' as `0x${string}`
const BATCH_DATA = '0xbatch'.replace('batch', 'abcdef') as `0x${string}`

const sdk: PlanEncodingSdk = {
  deploymentService: {
    getDeployment: () => ({ addresses: { coreAddrs: { evc: EVC } } }),
  },
  executionService: {
    encodeBatch: () => BATCH_DATA,
  },
}

const approvalItem = (resolved?: unknown[]) => ({
  type: 'requiredApproval',
  token: TOKEN,
  owner: OWNER,
  spender: SPENDER,
  amount: 100n,
  ...(resolved === undefined ? {} : { resolved }),
}) as unknown as TransactionPlan[number]

const approveResolved = {
  type: 'approve',
  token: TOKEN,
  owner: OWNER,
  spender: SPENDER,
  amount: 100n,
  data: APPROVE_DATA,
}

const evcBatchItem = (values: bigint[]) => ({
  type: 'evcBatch',
  items: values.map(value => ({
    targetContract: SPENDER,
    onBehalfOfAccount: OWNER,
    value,
    data: '0x01',
  })),
}) as unknown as TransactionPlan[number]

describe('transactionPlanToCalls', () => {
  it('converts approve + EVC batch into ordered calls', () => {
    const plan = [approvalItem([approveResolved]), evcBatchItem([2n, 3n])] as TransactionPlan

    const calls = transactionPlanToCalls(plan, sdk, 1)

    expect(calls).toEqual([
      { to: TOKEN, data: APPROVE_DATA, value: 0n },
      { to: EVC, data: BATCH_DATA, value: 5n },
    ])
  })

  it('throws for permit2-resolved approvals', () => {
    const plan = [
      approvalItem([{ type: 'permit2', token: TOKEN, amount: 100n, owner: OWNER, spender: SPENDER }]),
    ] as TransactionPlan

    expect(() => transactionPlanToCalls(plan, sdk, 1)).toThrow(PlanNotBundleableError)
  })

  it('throws for unresolved approval requirements', () => {
    expect(() => transactionPlanToCalls([approvalItem()] as TransactionPlan, sdk, 1))
      .toThrow(PlanNotBundleableError)
  })

  it('throws for CoW swap items', () => {
    const plan = [{ type: 'cowSwap', kind: 'order', chainId: 1, params: {} }] as unknown as TransactionPlan

    expect(() => transactionPlanToCalls(plan, sdk, 1)).toThrow(PlanNotBundleableError)
  })

  it('throws when the EVC address is missing for the chain', () => {
    const sdkWithoutEvc: PlanEncodingSdk = {
      ...sdk,
      deploymentService: { getDeployment: () => ({ addresses: { coreAddrs: {} } }) },
    }

    expect(() => transactionPlanToCalls([evcBatchItem([0n])] as TransactionPlan, sdkWithoutEvc, 1))
      .toThrow(PlanNotBundleableError)
  })

  it('mirrors execution eligibility through isPlanBundleable', () => {
    expect(isPlanBundleable([approvalItem([approveResolved]), evcBatchItem([0n])] as TransactionPlan)).toBe(true)
    // Single call gains nothing from bundling.
    expect(isPlanBundleable([evcBatchItem([0n])] as TransactionPlan)).toBe(false)
    // Permit2 signatures and unresolved approvals cannot bundle.
    expect(isPlanBundleable([
      approvalItem([{ type: 'permit2', token: TOKEN, amount: 100n, owner: OWNER, spender: SPENDER }]),
      evcBatchItem([0n]),
    ] as TransactionPlan)).toBe(false)
    expect(isPlanBundleable([approvalItem(), evcBatchItem([0n])] as TransactionPlan)).toBe(false)
    // Approval already satisfied (resolved: []) leaves one call.
    expect(isPlanBundleable([approvalItem([]), evcBatchItem([0n])] as TransactionPlan)).toBe(false)
  })

  it('hard-throws for contractCall items planned for another chain', () => {
    const plan = [{
      type: 'contractCall',
      chainId: 8453,
      to: SPENDER,
      abi: [{ type: 'function', name: 'ping', inputs: [], outputs: [], stateMutability: 'payable' }],
      functionName: 'ping',
      args: [],
      value: 0n,
    }] as unknown as TransactionPlan

    // Not a PlanNotBundleableError: falling back to sequential execution
    // would misroute the call identically, so this must fail loudly.
    expect(() => transactionPlanToCalls(plan, sdk, 1)).toThrow('targets chain 8453')
    try {
      transactionPlanToCalls(plan, sdk, 1)
    }
    catch (err) {
      expect(err).not.toBeInstanceOf(PlanNotBundleableError)
    }
  })

  it('encodes contractCall items', () => {
    const plan = [{
      type: 'contractCall',
      chainId: 1,
      to: SPENDER,
      abi: [{ type: 'function', name: 'ping', inputs: [], outputs: [], stateMutability: 'payable' }],
      functionName: 'ping',
      args: [],
      value: 7n,
    }] as unknown as TransactionPlan

    const calls = transactionPlanToCalls(plan, sdk, 1)

    expect(calls).toHaveLength(1)
    expect(calls[0].to).toBe(SPENDER)
    expect(calls[0].value).toBe(7n)
    expect(calls[0].data.startsWith('0x')).toBe(true)
  })
})
