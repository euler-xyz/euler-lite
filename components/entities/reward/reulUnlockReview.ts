import type { REULLock, REULLockSnapshot } from '~/entities/reul'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'

export type REULLockReviewValidation
  = { status: 'fresh', lock: REULLock, blockTimestamp: bigint }
    | { status: 'changed' | 'missing' | 'unavailable' }

type ReadREULLockSnapshot = () => Promise<REULLockSnapshot | null>

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
  readSnapshot: ReadREULLockSnapshot,
): Promise<REULLockReviewValidation> => {
  const snapshot = await readSnapshot()
  if (!snapshot) return { status: 'unavailable' }

  const currentLock = snapshot.lock
  if (!currentLock || currentLock.timestamp !== reviewedLock.timestamp) return { status: 'missing' }

  if (
    currentLock.amount !== reviewedLock.amount
    || currentLock.unlockableAmount < reviewedLock.unlockableAmount
    || currentLock.amountToBeBurned > reviewedLock.amountToBeBurned
  ) {
    return { status: 'changed' }
  }

  return { status: 'fresh', lock: currentLock, blockTimestamp: snapshot.blockTimestamp }
}
