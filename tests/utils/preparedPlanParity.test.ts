import { describe, expect, it } from 'vitest'
import { encodeFunctionData, type Address, type Hex } from 'viem'
import type { TransactionPlan, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { assertPreparedPlanSignatureParity } from '~/utils/preparedPlanParity'

const owner = '0x1000000000000000000000000000000000000000' as Address
const target = '0x2000000000000000000000000000000000000000' as Address
const otherTarget = '0x3000000000000000000000000000000000000000' as Address
const placeholder = `0x${'00'.repeat(65)}` as Hex
const signature = `0x${'11'.repeat(32)}${'22'.repeat(32)}01` as Hex
const secondSignature = `0x${'33'.repeat(32)}${'44'.repeat(32)}1c` as Hex

const permitAbi = [{
  type: 'function',
  name: 'permit',
  inputs: [
    { name: 'owner', type: 'address' },
    { name: 'spender', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'v', type: 'uint8' },
    { name: 'r', type: 'bytes32' },
    { name: 's', type: 'bytes32' },
  ],
  outputs: [],
  stateMutability: 'nonpayable',
}] as const

const splitSignature = (authorization: Hex) => {
  let v = Number.parseInt(authorization.slice(130, 132), 16)
  if (v < 27) v += 27
  return {
    r: authorization.slice(0, 66) as Hex,
    s: `0x${authorization.slice(66, 130)}` as Hex,
    v,
  }
}

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

// Two structurally identical placeholder sites: only the signature bytes can
// tell the resolved items apart.
const planWithTwoSignatures = (first: Hex, second: Hex): TransactionPlan => [{
  type: 'evcBatch',
  items: [{
    type: 'operation',
    name: 'migration',
    items: [
      {
        targetContract: target,
        onBehalfOfAccount: owner,
        value: 7n,
        data: `0x1234${first.slice(2)}abcd` as Hex,
      },
      {
        targetContract: target,
        onBehalfOfAccount: owner,
        value: 7n,
        data: `0x1234${second.slice(2)}abcd` as Hex,
      },
    ],
  }],
}]

const planWithAbiSignature = (authorization: Hex): TransactionPlan => {
  const { r, s, v } = splitSignature(authorization)
  return [{
    type: 'evcBatch',
    items: [{
      type: 'operation',
      name: 'aave-migration',
      items: [{
        targetContract: target,
        onBehalfOfAccount: owner,
        value: 0n,
        data: encodeFunctionData({
          abi: permitAbi,
          functionName: 'permit',
          args: [owner, otherTarget, 7n, 123n, v, r, s],
        }),
      }],
    }],
  }]
}

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

  it('accepts the production ABI v/r/s encoding at the reviewed offsets', () => {
    expect(() => assertPreparedPlanSignatureParity({
      reviewed: prepared(planWithAbiSignature(placeholder)),
      resolved: prepared(planWithAbiSignature(signature)),
      substitutions: [{ placeholder, signature }],
    })).not.toThrow()
  })

  it('rejects an unrelated change beside a production ABI v/r/s substitution', () => {
    const resolved = planWithAbiSignature(signature)
    const batch = resolved[0] as Extract<TransactionPlan[number], { type: 'evcBatch' }>
    const operation = batch.items[0]
    if ('items' in operation) operation.items[0]!.value = 1n

    expect(() => assertPreparedPlanSignatureParity({
      reviewed: prepared(planWithAbiSignature(placeholder)),
      resolved: prepared(resolved),
      substitutions: [{ placeholder, signature }],
    })).toThrow('transaction plan changed after review')
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

  it('accepts two ordered substitutions across identical placeholder sites', () => {
    expect(() => assertPreparedPlanSignatureParity({
      reviewed: prepared(planWithTwoSignatures(placeholder, placeholder)),
      resolved: prepared(planWithTwoSignatures(signature, secondSignature)),
      substitutions: [
        { placeholder, signature },
        { placeholder, signature: secondSignature },
      ],
    })).not.toThrow()
  })

  it('rejects signatures transposed between identical placeholder sites', () => {
    expect(() => assertPreparedPlanSignatureParity({
      reviewed: prepared(planWithTwoSignatures(placeholder, placeholder)),
      resolved: prepared(planWithTwoSignatures(secondSignature, signature)),
      substitutions: [
        { placeholder, signature },
        { placeholder, signature: secondSignature },
      ],
    })).toThrow('transaction plan changed after review')
  })

  it('binds substitution order within a single calldata string', () => {
    const dataWith = (first: Hex, second: Hex): TransactionPlan => [{
      type: 'evcBatch',
      items: [{
        type: 'operation',
        name: 'migration',
        items: [{
          targetContract: target,
          onBehalfOfAccount: owner,
          value: 7n,
          data: `0x${first.slice(2)}${second.slice(2)}` as Hex,
        }],
      }],
    }]
    const substitutions = [
      { placeholder, signature },
      { placeholder, signature: secondSignature },
    ]
    expect(() => assertPreparedPlanSignatureParity({
      reviewed: prepared(dataWith(placeholder, placeholder)),
      resolved: prepared(dataWith(signature, secondSignature)),
      substitutions,
    })).not.toThrow()
    expect(() => assertPreparedPlanSignatureParity({
      reviewed: prepared(dataWith(placeholder, placeholder)),
      resolved: prepared(dataWith(secondSignature, signature)),
      substitutions,
    })).toThrow('transaction plan changed after review')
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
