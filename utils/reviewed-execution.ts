import { isEVCBatchOperation, type TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { toFunctionSelector } from 'viem'

export const REVIEWED_EXECUTION_UNAVAILABLE_ERROR
  = 'The reviewed transaction is unavailable. Close this review and try again.'

export const REVIEWED_EXECUTION_CHANGED_ERROR
  = 'The transaction changed while it was being refreshed. Close this review and try again.'

const PYTH_UPDATE_SELECTOR = toFunctionSelector('function updatePriceFeeds(bytes[])')

const canonicalizePythUpdate = (item: Record<string, unknown>): Record<string, unknown> => {
  const data = typeof item.data === 'string' ? item.data : ''
  if (data.slice(0, 10).toLowerCase() !== PYTH_UPDATE_SELECTOR.toLowerCase()) return item
  return {
    ...item,
    data: '__fresh_pyth_update__',
    value: '__fresh_pyth_fee__',
  }
}

const canonicalizeReviewedPlan = (prepared: TransactionPlanPrepared): string => JSON.stringify({
  chainId: prepared.chainId,
  account: (typeof prepared.account === 'string' ? prepared.account : prepared.account.owner).toLowerCase(),
  usePermit2: prepared.usePermit2,
  unlimitedApproval: prepared.unlimitedApproval,
  plan: prepared.plan.map((item) => {
    if (item.type !== 'evcBatch') return item
    return {
      ...item,
      items: item.items.map(entry => isEVCBatchOperation(entry)
        ? { ...entry, items: entry.items.map(call => canonicalizePythUpdate(call)) }
        : canonicalizePythUpdate(entry)),
    }
  }),
}, (_key, value) => typeof value === 'bigint' ? `${value.toString()}n` : value)

/**
 * Permit a just-in-time Pyth payload/fee refresh while requiring every reviewed
 * approval, operation, target and execution option to remain exact.
 */
export const requirePythOnlyPreparedRefresh = (
  reviewed: TransactionPlanPrepared,
  refreshed: TransactionPlanPrepared,
): TransactionPlanPrepared => {
  if (canonicalizeReviewedPlan(reviewed) !== canonicalizeReviewedPlan(refreshed)) {
    throw new Error(REVIEWED_EXECUTION_CHANGED_ERROR)
  }
  return refreshed
}

export const requireReviewedExecution = (
  reviewed: TransactionPlanPrepared | undefined,
): TransactionPlanPrepared => {
  if (!reviewed) throw new Error(REVIEWED_EXECUTION_UNAVAILABLE_ERROR)
  return reviewed
}
