import { describe, expect, it } from 'vitest'
import type { TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import {
  requireReviewedExecution,
  REVIEWED_EXECUTION_UNAVAILABLE_ERROR,
} from '~/utils/reviewed-execution'

describe('requireReviewedExecution', () => {
  it('returns the exact reviewed artifact by identity', () => {
    const reviewed = { plan: [], chainId: 1 } as unknown as TransactionPlanPrepared

    expect(requireReviewedExecution(reviewed)).toBe(reviewed)
  })

  it('fails closed when review did not provide an executable artifact', () => {
    expect(() => requireReviewedExecution(undefined)).toThrow(REVIEWED_EXECUTION_UNAVAILABLE_ERROR)
  })
})
