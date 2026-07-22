import { describe, expect, it, vi } from 'vitest'
import {
  assertReviewedExecutionCurrent,
  ReviewedExecutionChangedError,
} from '~/utils/reviewedExecution'

describe('reviewed execution state', () => {
  it('does not continue to a transaction after reviewed inputs change', () => {
    const sendTransaction = vi.fn()

    expect(() => {
      assertReviewedExecutionCurrent({
        reviewedKey: 'owner-a:debt-100',
        currentKey: 'owner-a:debt-101',
      })
      sendTransaction()
    }).toThrow(ReviewedExecutionChangedError)
    expect(sendTransaction).not.toHaveBeenCalled()
  })

  it('allows execution when the reviewed inputs are unchanged', () => {
    expect(() => assertReviewedExecutionCurrent({
      reviewedKey: 'owner-a:debt-100',
      currentKey: 'owner-a:debt-100',
    })).not.toThrow()
  })
})
