import type { EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { INTEREST_RATE_MODEL_TYPE } from '~/entities/constants'

/**
 * Should borrow-side UI / aggregation treat this vault as borrowable?
 *
 * `EVault.isBorrowable` is config-derived (some collateral has an active borrow
 * or liquidation LTV, including active ramp-down) and answers "can a *new*
 * borrow be opened". This predicate additionally returns true when there is
 * residual outstanding debt (`totalBorrowed > 0`) — e.g. a vault whose LTVs
 * have fully ramped to zero but whose existing borrows are still being repaid.
 * Use it to gate borrow-side display (overview blocks) and discovery
 * aggregates so residual exposure stays visible and counted.
 *
 * Escrow / non-borrowable vault types report `isBorrowable === false` and carry
 * no debt, so they remain non-borrowable here.
 */
export const isVaultBorrowable = (
  vault: Pick<EVault, 'isBorrowable' | 'totalBorrowed'>,
): boolean => vault.isBorrowable || vault.totalBorrowed > 0n

export const isCyclicalNoteVault = (
  vault: EVault | SecuritizeCollateralVault | null | undefined,
): boolean => {
  if (!vault) return false
  const type = (vault as { interestRateModel?: { type?: unknown } }).interestRateModel?.type
  return typeof type === 'number'
    && (type === INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY
      || type === INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY_MONTHLY)
}
