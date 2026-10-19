import { flattenBatchEntries, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { getAddress, isAddress } from 'viem'

/**
 * Every contract a plan can reach as a vault: EVC batch targets, direct calls
 * and the spenders of required approvals (a supply outside an EVC batch reaches
 * the vault only through those two).
 */
export const planVaultTargets = (plan: TransactionPlan): string[] => plan.flatMap((item) => {
  if (item.type === 'evcBatch') return flattenBatchEntries(item.items).map(entry => entry.targetContract)
  if (item.type === 'contractCall') return [item.to]
  if (item.type === 'requiredApproval') return [item.spender]
  return []
})

interface PlanVaultLookup {
  getVault: (address: string) => { shares?: { name?: string }, asset?: { symbol?: string } } | undefined
  isVerifiedVault: (address: string) => boolean
}

export const collectUnverifiedPlanVaults = (
  plans: readonly TransactionPlan[],
  { getVault, isVerifiedVault }: PlanVaultLookup,
): Array<{ address: string, name: string }> => {
  const vaults = new Map<string, string>()
  for (const target of plans.flatMap(planVaultTargets)) {
    if (!isAddress(target, { strict: false })) continue
    const address = getAddress(target)
    const vault = getVault(address)
    const name = vault?.shares?.name || vault?.asset?.symbol || ''
    if (vault && name && !isVerifiedVault(address)) vaults.set(address.toLowerCase(), name)
  }
  return [...vaults].map(([address, name]) => ({ address, name }))
}
