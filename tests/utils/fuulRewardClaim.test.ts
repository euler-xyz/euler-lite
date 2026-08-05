import type { TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { describe, expect, it, vi } from 'vitest'

import { executeReviewedFuulClaim } from '~/utils/fuulRewardClaim'

const reviewedPlan = {
  __prepared: true,
  plan: [],
  chainId: 1,
  account: '0x0000000000000000000000000000000000000001',
  usePermit2: false,
  unlimitedApproval: false,
} as const satisfies TransactionPlanPrepared

describe('executeReviewedFuulClaim', () => {
  it('executes the exact prepared envelope captured by the review', async () => {
    const executePreparedPlan = vi.fn().mockResolvedValue(undefined)

    await executeReviewedFuulClaim(reviewedPlan, executePreparedPlan)

    expect(executePreparedPlan).toHaveBeenCalledOnce()
    expect(executePreparedPlan).toHaveBeenCalledWith(reviewedPlan)
  })

  it('fails closed when the reviewed envelope is unavailable', async () => {
    const executePreparedPlan = vi.fn().mockResolvedValue(undefined)

    await expect(executeReviewedFuulClaim(undefined, executePreparedPlan))
      .rejects.toThrow('The reviewed Fuul claim is unavailable')
    expect(executePreparedPlan).not.toHaveBeenCalled()
  })
})
