import { describe, expect, it, vi } from 'vitest'
import type { REULLock } from '~/entities/reul'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import {
  prepareREULUnlockPlan,
  runWithFreshREULLockReview,
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

describe('runWithFreshREULLockReview', () => {
  it('does not execute when a deferred refresh returns a different burn quote', async () => {
    let resolveRefresh!: (locks: REULLock[]) => void
    const pendingRefresh = new Promise<REULLock[]>((resolve) => {
      resolveRefresh = resolve
    })
    const execute = vi.fn(async () => true)

    const resultPromise = runWithFreshREULLockReview(
      reviewedLock,
      () => pendingRefresh,
      execute,
    )

    expect(execute).not.toHaveBeenCalled()
    resolveRefresh([{
      ...reviewedLock,
      amountToBeBurned: 30n,
    }])

    await expect(resultPromise).resolves.toEqual({ status: 'changed' })
    expect(execute).not.toHaveBeenCalled()
  })

  it('executes only after the refreshed lock matches the reviewed amounts', async () => {
    const currentLock = { ...reviewedLock }
    const execute = vi.fn(async () => true)

    await expect(runWithFreshREULLockReview(
      reviewedLock,
      async () => [currentLock],
      execute,
    )).resolves.toEqual({ status: 'executed' })
    expect(execute).toHaveBeenCalledWith(currentLock)
  })

  it('accepts the naturally improved unlock quote at confirmation', async () => {
    const improvedLock = {
      ...reviewedLock,
      unlockableAmount: 81n,
      amountToBeBurned: 19n,
    }
    const execute = vi.fn(async () => true)

    await expect(runWithFreshREULLockReview(
      reviewedLock,
      async () => [improvedLock],
      execute,
    )).resolves.toEqual({ status: 'executed' })
    expect(execute).toHaveBeenCalledWith(improvedLock)
  })
})
