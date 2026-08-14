import { describe, expect, it } from 'vitest'
import type { Address, Hex } from 'viem'
import type { TransactionPlan, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { assertPreparedPlanSignatureParity } from '~/utils/preparedPlanParity'

const owner = '0x1000000000000000000000000000000000000000' as Address
const target = '0x2000000000000000000000000000000000000000' as Address
const otherTarget = '0x3000000000000000000000000000000000000000' as Address
const placeholder = `0x${'00'.repeat(65)}` as Hex
const signature = `0x${'11'.repeat(65)}` as Hex

const planWithSignature = (authorization: Hex): TransactionPlan => [{
  type: 'evcBatch',
  items: [{
    type: 'operation',
    name: 'migration',
    items: [{
      targetContract: target,
      onBehalfOfAccount: owner,
      value: 7n,
      data: `0x1234${authorization.slice(2)}abcd` as Hex,
    }],
  }],
}]

const prepared = (plan: TransactionPlan): TransactionPlanPrepared => ({
  __prepared: true,
  plan,
  chainId: 1,
  account: owner,
  usePermit2: true,
  unlimitedApproval: false,
})

const assertParity = (resolvedPlan: TransactionPlan) => assertPreparedPlanSignatureParity({
  reviewed: prepared(planWithSignature(placeholder)),
  resolved: prepared(resolvedPlan),
  substitutions: [{ placeholder, signature }],
})

describe('assertPreparedPlanSignatureParity', () => {
  it('accepts exactly one reviewed placeholder-to-signature substitution', () => {
    expect(() => assertParity(planWithSignature(signature))).not.toThrow()
  })

  it.each([
    ['target', () => {
      const plan = planWithSignature(signature)
      const operation = plan[0] as Extract<TransactionPlan[number], { type: 'evcBatch' }>
      const item = operation.items[0]
      if ('items' in item) item.items[0]!.targetContract = otherTarget
      return plan
    }],
    ['value', () => {
      const plan = planWithSignature(signature)
      const operation = plan[0] as Extract<TransactionPlan[number], { type: 'evcBatch' }>
      const item = operation.items[0]
      if ('items' in item) item.items[0]!.value = 8n
      return plan
    }],
    ['order', () => {
      const plan = planWithSignature(signature)
      const operation = plan[0] as Extract<TransactionPlan[number], { type: 'evcBatch' }>
      const item = operation.items[0]
      if ('items' in item) {
        item.items.push({ ...item.items[0]!, data: '0xbeef' })
        item.items.reverse()
      }
      return plan
    }],
    ['approval', () => [{
      type: 'requiredApproval',
      token: target,
      owner,
      spender: otherTarget,
      amount: 1n,
      resolved: [{ type: 'approve', token: target, data: '0x1234' }],
    }, ...planWithSignature(signature)] as TransactionPlan],
    ['plugin call', () => [{
      type: 'contractCall',
      chainId: 1,
      to: otherTarget,
      abi: [],
      functionName: 'unexpected',
      args: [],
      value: 0n,
    }, ...planWithSignature(signature)] as TransactionPlan],
  ])('rejects a confirm-time %s change', (_label, mutate) => {
    expect(() => assertParity(mutate())).toThrow('transaction plan changed after review')
  })

  it('rejects a missing or extra signature occurrence', () => {
    expect(() => assertParity(planWithSignature(placeholder))).toThrow('transaction plan changed after review')
    const duplicated = planWithSignature(signature)
    const batch = duplicated[0] as Extract<TransactionPlan[number], { type: 'evcBatch' }>
    const operation = batch.items[0]
    if ('items' in operation) operation.items.push({ ...operation.items[0]! })
    expect(() => assertParity(duplicated)).toThrow('transaction plan changed after review')
  })
})
