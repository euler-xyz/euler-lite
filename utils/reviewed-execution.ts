import { isEVCBatchOperation, type TransactionPlan, type TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { toFunctionSelector } from 'viem'

export const REVIEWED_EXECUTION_UNAVAILABLE_ERROR
  = 'The reviewed transaction is unavailable. Close this review and try again.'

export const REVIEWED_EXECUTION_CHANGED_ERROR
  = 'The transaction changed while it was being refreshed. Close this review and try again.'

const PYTH_UPDATE_SELECTOR = toFunctionSelector('function updatePriceFeeds(bytes[])')

const isPythUpdate = (item: Record<string, unknown>): boolean => {
  const data = typeof item.data === 'string' ? item.data : ''
  return data.slice(0, 10).toLowerCase() === PYTH_UPDATE_SELECTOR.toLowerCase()
}

const canonicalizePythUpdate = (item: Record<string, unknown>): Record<string, unknown> => {
  if (!isPythUpdate(item)) return item
  return {
    ...item,
    data: '__fresh_pyth_update__',
    value: '__fresh_pyth_fee__',
  }
}

export const hasPreparedPythUpdate = (prepared: TransactionPlanPrepared): boolean =>
  prepared.plan.some(item => item.type === 'evcBatch' && item.items.some(entry =>
    (isEVCBatchOperation(entry) ? entry.items : [entry]).some(call => isPythUpdate(call)),
  ))

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

type PrepareReviewedPlan = (
  plan: TransactionPlan,
  options: Pick<TransactionPlanPrepared, 'account' | 'chainId' | 'usePermit2'>,
) => Promise<TransactionPlanPrepared>

/**
 * Refresh short-lived Pyth payloads at the shared confirmation boundary while
 * pinning preparation to the exact account, chain and Permit2 mode reviewed.
 */
export const refreshReviewedPythExecution = async (
  reviewed: TransactionPlanPrepared,
  rawPlan: TransactionPlan | undefined,
  prepare: PrepareReviewedPlan,
): Promise<TransactionPlanPrepared> => {
  if (!hasPreparedPythUpdate(reviewed)) return reviewed
  if (!rawPlan?.length) throw new Error(REVIEWED_EXECUTION_UNAVAILABLE_ERROR)
  const refreshed = await prepare(rawPlan, {
    account: reviewed.account,
    chainId: reviewed.chainId,
    usePermit2: reviewed.usePermit2,
  })
  return requirePythOnlyPreparedRefresh(reviewed, refreshed)
}

export const requireReviewedExecution = (
  reviewed: TransactionPlanPrepared | undefined,
): TransactionPlanPrepared => {
  if (!reviewed) throw new Error(REVIEWED_EXECUTION_UNAVAILABLE_ERROR)
  return reviewed
}
