export interface REULLock {
  timestamp: bigint
  amount: bigint
  unlockableAmount: bigint
  amountToBeBurned: bigint
}

export interface REULLockSnapshot {
  blockNumber: bigint
  blockTimestamp: bigint
  lock: REULLock | null
}

export const REUL_LOCK_DAY_SECONDS = 86_400n

// rEUL adds every delivery to the lock keyed by the current UTC day, so a lock
// from an earlier day can only shrink, and its vested share only grows. Once
// chain time has passed the end of the lock's day, the remainder quoted at that
// time is an upper bound for any later execution. Missing chain time fails
// closed.
export const isREULLockClosed = (lockTimestamp: bigint, chainTimestamp: bigint | undefined): boolean =>
  chainTimestamp !== undefined && lockTimestamp + REUL_LOCK_DAY_SECONDS <= chainTimestamp
