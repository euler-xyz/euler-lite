import type { REULLock } from '~/entities/reul'

export type REULLockReviewValidation
  = { status: 'fresh', lock: REULLock }
    | { status: 'changed' | 'missing' | 'unavailable' }

type RefreshREULLocks = () => Promise<REULLock[] | null>

export const refreshREULLockReview = async (
  reviewedLock: REULLock,
  refreshLocks: RefreshREULLocks,
): Promise<REULLockReviewValidation> => {
  const refreshedLocks = await refreshLocks()
  if (!refreshedLocks) return { status: 'unavailable' }

  const currentLock = refreshedLocks.find(lock => lock.timestamp === reviewedLock.timestamp)
  if (!currentLock) return { status: 'missing' }

  if (
    currentLock.unlockableAmount !== reviewedLock.unlockableAmount
    || currentLock.amountToBeBurned !== reviewedLock.amountToBeBurned
  ) {
    return { status: 'changed' }
  }

  return { status: 'fresh', lock: currentLock }
}

export const runWithFreshREULLockReview = async (
  reviewedLock: REULLock,
  refreshLocks: RefreshREULLocks,
  execute: (currentLock: REULLock) => Promise<boolean>,
): Promise<REULLockReviewValidation | { status: 'executed' | 'cancelled' }> => {
  const validation = await refreshREULLockReview(reviewedLock, refreshLocks)
  if (validation.status !== 'fresh') return validation

  return await execute(validation.lock)
    ? { status: 'executed' }
    : { status: 'cancelled' }
}
