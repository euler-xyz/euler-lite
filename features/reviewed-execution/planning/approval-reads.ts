import type { Address } from 'viem'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'

export type AllowanceReadIssue = { source?: string, message: string }

export type WalletFetchForApprovals<TWallet> = { result: TWallet, errors: readonly AllowanceReadIssue[] }

const ALLOWANCE_SOURCES = new Set(['erc20.allowance', 'permit2.allowance'])

export const allowanceReadIssues = (errors: readonly AllowanceReadIssue[]): AllowanceReadIssue[] =>
  errors.filter(issue => issue.source !== undefined && ALLOWANCE_SOURCES.has(issue.source))

export const approvalAssetsWithSpenders = (plan: TransactionPlan): Array<{ asset: Address, spenders: Address[] }> => {
  const spendersByAsset = new Map<string, { asset: Address, spenders: Address[] }>()
  for (const item of plan) {
    if (item.type !== 'requiredApproval') continue
    const key = item.token.toLowerCase()
    const entry = spendersByAsset.get(key) ?? { asset: item.token, spenders: [] }
    if (!entry.spenders.some(spender => spender.toLowerCase() === item.spender.toLowerCase())) entry.spenders.push(item.spender)
    spendersByAsset.set(key, entry)
  }
  return [...spendersByAsset.values()]
}

/**
 * A failed allowance read makes the resolver assume no allowance and add an
 * on-chain approval that may already exist. One retry absorbs a transient
 * network failure; a persistent one is returned so the review can say so.
 */
export const fetchWalletForApprovals = async <TWallet>(
  fetchWallet: () => Promise<WalletFetchForApprovals<TWallet>>,
  wait: () => Promise<void> = () => new Promise(resolve => setTimeout(resolve, 500)),
): Promise<{ wallet: TWallet, allowanceIssues: AllowanceReadIssue[] }> => {
  const first = await fetchWallet()
  const firstIssues = allowanceReadIssues(first.errors)
  if (!firstIssues.length) return { wallet: first.result, allowanceIssues: [] }
  await wait()
  const second = await fetchWallet()
  return { wallet: second.result, allowanceIssues: allowanceReadIssues(second.errors) }
}
