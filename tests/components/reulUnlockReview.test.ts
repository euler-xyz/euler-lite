import { describe, expect, it, vi } from 'vitest'
import type { REULLock } from '~/entities/reul'
import { runWithFreshREULLockReview } from '~/components/entities/reward/reulUnlockReview'

const reviewedLock: REULLock = {
  timestamp: 1n,
  amount: 100n,
  unlockableAmount: 80n,
  amountToBeBurned: 20n,
}

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
