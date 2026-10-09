export interface REULLock {
  timestamp: bigint
  amount: bigint
  unlockableAmount: bigint
  amountToBeBurned: bigint
}

const REUL_LOCK_DAY_SECONDS = 86_400n
// Covers a browser clock running ahead of chain time around UTC midnight.
const REUL_LOCK_CLOCK_MARGIN_SECONDS = 3_600n

// rEUL adds every locked delivery to the lock keyed by the current UTC day, so
// only that lock can grow between review and execution.
export const getREULLockClosedAt = (lockTimestamp: bigint): bigint =>
  lockTimestamp + REUL_LOCK_DAY_SECONDS + REUL_LOCK_CLOCK_MARGIN_SECONDS

export const isREULLockOpen = (lockTimestamp: bigint, nowMs = Date.now()): boolean =>
  BigInt(Math.floor(nowMs / 1000)) < getREULLockClosedAt(lockTimestamp)
