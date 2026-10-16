import { describe, expect, it } from 'vitest'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { planVaultTargets } from '~/utils/plan-vault-targets'

const vault = '0x0000000000000000000000000000000000000011'
const other = '0x0000000000000000000000000000000000000012'
const token = '0x0000000000000000000000000000000000000021'

describe('planVaultTargets', () => {
  it('collects EVC batch targets, direct call targets and approval spenders', () => {
    const plan = [
      { type: 'evcBatch', items: [{ targetContract: vault, onBehalfOfAccount: other, value: 0n, data: '0x' }] },
      { type: 'contractCall', chainId: 1, to: other, abi: [], functionName: 'deposit', args: [], value: 0n },
      { type: 'requiredApproval', token, owner: other, spender: vault, amount: 1n },
    ] as unknown as TransactionPlan
    expect(planVaultTargets(plan)).toEqual([vault, other, vault])
  })

  it('ignores plan items that reach no contract', () => {
    const plan = [{ type: 'cowSwap', kind: 'openPosition', chainId: 1, params: {} }] as unknown as TransactionPlan
    expect(planVaultTargets(plan)).toEqual([])
  })
})
