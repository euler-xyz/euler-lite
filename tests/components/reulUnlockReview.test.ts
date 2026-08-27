import { describe, expect, it, vi } from 'vitest'
import type { REULLock } from '~/entities/reul'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import {
  prepareREULUnlockPlan,
} from '~/components/entities/reward/reulUnlockReview'

const reviewedLock: REULLock = {
  timestamp: 1n,
  amount: 100n,
  unlockableAmount: 80n,
  amountToBeBurned: 20n,
}

describe('prepareREULUnlockPlan', () => {
  const plan = [] as TransactionPlan

  it('reports a build failure without attempting simulation', async () => {
    const buildError = new Error('build failed')
    const simulatePlan = vi.fn(async () => true)

    await expect(prepareREULUnlockPlan(
      reviewedLock,
      async () => { throw buildError },
      simulatePlan,
    )).resolves.toEqual({ status: 'build-failed', error: buildError })
    expect(simulatePlan).not.toHaveBeenCalled()
  })

  it('reports a failed simulation instead of returning a reviewable plan', async () => {
    const simulatePlan = vi.fn(async () => false)

    await expect(prepareREULUnlockPlan(
      reviewedLock,
      async () => plan,
      simulatePlan,
    )).resolves.toEqual({ status: 'simulation-failed' })
    expect(simulatePlan).toHaveBeenCalledWith(plan)
  })
})
