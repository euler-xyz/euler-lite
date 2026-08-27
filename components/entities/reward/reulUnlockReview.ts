import type { REULLock } from '~/entities/reul'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'

export type REULLockReviewValidation
  = { status: 'fresh', lock: REULLock }
    | { status: 'changed' | 'missing' | 'unavailable' }

type RefreshREULLocks = () => Promise<REULLock[] | null>

export type REULUnlockPlanPreparation
  = { status: 'ready', plan: TransactionPlan }
    | { status: 'build-failed', error: unknown }
    | { status: 'simulation-failed' }

export const prepareREULUnlockPlan = async (
  lock: REULLock,
  buildPlan: (lock: REULLock) => Promise<TransactionPlan>,
  simulatePlan: (plan: TransactionPlan) => Promise<boolean>,
): Promise<REULUnlockPlanPreparation> => {
  let plan: TransactionPlan
  try {
    plan = await buildPlan(lock)
  }
  catch (error) {
    return { status: 'build-failed', error }
  }

  if (!await simulatePlan(plan)) return { status: 'simulation-failed' }
  return { status: 'ready', plan }
}

export const refreshREULLockReview = async (
  reviewedLock: REULLock,
  refreshLocks: RefreshREULLocks,
): Promise<REULLockReviewValidation> => {
  const refreshedLocks = await refreshLocks()
  if (!refreshedLocks) return { status: 'unavailable' }

  const currentLock = refreshedLocks.find(lock => lock.timestamp === reviewedLock.timestamp)
  if (!currentLock) return { status: 'missing' }

  if (
    currentLock.amount !== reviewedLock.amount
    || currentLock.unlockableAmount < reviewedLock.unlockableAmount
    || currentLock.amountToBeBurned > reviewedLock.amountToBeBurned
  ) {
    return { status: 'changed' }
  }

  return { status: 'fresh', lock: currentLock }
}
