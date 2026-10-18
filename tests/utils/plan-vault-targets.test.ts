import { describe, expect, it } from 'vitest'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { collectUnverifiedPlanVaults, planVaultTargets } from '~/utils/plan-vault-targets'
import { getFlaggedActionNotice } from '~/utils/vault-assessment/flagged'

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

describe('collectUnverifiedPlanVaults', () => {
  const listed = '0x0000000000000000000000000000000000000031'
  const flagged = '0x0000000000000000000000000000000000000032'
  const vaults: Record<string, { shares: { name: string } }> = {
    [listed]: { shares: { name: 'Listed vault' } },
    [flagged]: { shares: { name: 'Flagged vault' } },
  }
  const deps = {
    getVault: (address: string) => vaults[address.toLowerCase()],
    isVerifiedVault: (address: string) => address.toLowerCase() === listed,
  }

  it('reads the vaults from the calldata, not from the page the operation started on', () => {
    const plan = [
      { type: 'requiredApproval', token, owner: other, spender: listed, amount: 1n },
      { type: 'evcBatch', items: [
        { targetContract: listed, onBehalfOfAccount: other, value: 0n, data: '0x' },
        { targetContract: flagged, onBehalfOfAccount: other, value: 0n, data: '0x' },
      ] },
    ] as unknown as TransactionPlan
    const unverified = collectUnverifiedPlanVaults([plan], deps)
    expect(unverified).toEqual([{ address: flagged, name: 'Flagged vault' }])
    const visibility = { [flagged]: { status: 'hidden', decidedBy: 'config-failed', reason: 'The oracle failed' } }
    expect(getFlaggedActionNotice(unverified.map(vault => vault.address), 'v3', visibility))
      .toBe('This transaction uses a flagged vault: The oracle failed.')
  })

  it('skips contracts that are not known vaults and repeats nothing', () => {
    const plan = [
      { type: 'evcBatch', items: [{ targetContract: flagged, onBehalfOfAccount: other, value: 0n, data: '0x' }] },
      { type: 'contractCall', chainId: 1, to: other, abi: [], functionName: 'swap', args: [], value: 0n },
    ] as unknown as TransactionPlan
    expect(collectUnverifiedPlanVaults([plan, plan], deps)).toEqual([{ address: flagged, name: 'Flagged vault' }])
  })
})
