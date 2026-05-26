import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'

const normalizeAddress = (address?: string) => address?.toLowerCase()

export const hasPermit2Signature = (plan?: TransactionPlan): boolean =>
  plan?.some(item => item.type === 'requiredApproval'
    && item.resolved?.some(resolved => resolved.type === 'permit2')) ?? false

export const hasPermit2TokenApproval = (
  plan?: TransactionPlan,
  permit2Address?: string,
): boolean => {
  const normalizedPermit2 = normalizeAddress(permit2Address)

  return plan?.some((item) => {
    if (item.type !== 'requiredApproval') return false

    const requiredSpender = normalizeAddress(item.spender)

    return item.resolved?.some((resolved) => {
      if (resolved.type !== 'approve' || resolved.amount <= 0n) return false

      const approvalSpender = normalizeAddress(resolved.spender)
      if (!approvalSpender) return false

      if (normalizedPermit2) {
        return approvalSpender === normalizedPermit2
      }

      // If deployment addresses have not loaded yet, SDK Permit2 approvals are
      // still distinguishable from direct approvals because they approve a
      // spender different from the required approval's final spender.
      return approvalSpender !== requiredSpender
    }) ?? false
  }) ?? false
}
