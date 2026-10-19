export interface REULLock {
  timestamp: bigint
  amount: bigint
  unlockableAmount: bigint
  amountToBeBurned: bigint
}

const REUL_LOCK_DAY_SECONDS = 86_400n

// rEUL adds every locked delivery to the lock keyed by the current UTC day, so
// only that lock can grow between review and execution.
export const getREULLockClosedAt = (lockTimestamp: bigint): bigint =>
  lockTimestamp + REUL_LOCK_DAY_SECONDS

export const isREULLockOpen = (lockTimestamp: bigint, nowSeconds: bigint): boolean =>
  nowSeconds < getREULLockClosedAt(lockTimestamp)
