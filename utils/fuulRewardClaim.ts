import type { TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'

export const executeReviewedFuulClaim = async (
  reviewedPlan: TransactionPlanPrepared | undefined,
  executePreparedPlan: (prepared: TransactionPlanPrepared) => Promise<unknown>,
) => {
  if (!reviewedPlan) {
    throw new Error('The reviewed Fuul claim is unavailable. Close this review and try again.')
  }

  await executePreparedPlan(reviewedPlan)
}
