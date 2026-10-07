import { flattenBatchEntries, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'

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
