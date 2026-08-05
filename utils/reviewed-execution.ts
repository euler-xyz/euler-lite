import type { TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'

export const REVIEWED_EXECUTION_UNAVAILABLE_ERROR
  = 'The reviewed transaction is unavailable. Close this review and try again.'

export const requireReviewedExecution = (
  reviewed: TransactionPlanPrepared | undefined,
): TransactionPlanPrepared => {
  if (!reviewed) throw new Error(REVIEWED_EXECUTION_UNAVAILABLE_ERROR)
  return reviewed
}
