import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { isVaultNotExplorableBorrow } from '~/utils/eulerLabelsUtils'

/** An Unknown collateral (no published label verifies it) stays on the market graph but out of the Borrow table. */
export const isBorrowTableCollateral = (collateralAddress: string, showAllLabelEntries: boolean): boolean =>
  showAllLabelEntries
  || (useVaultRegistry().isVerifiedVault(collateralAddress) && !isVaultNotExplorableBorrow(collateralAddress))

/** Lend-table eligibility: a borrowLTV > 0 pair of this vault whose collateral passes `isCollateralListed`. */
export const hasBorrowTablePair = (
  vaultAddress: string,
  pairs: readonly AnyBorrowVaultPair[],
  isCollateralListed: (collateralAddress: string) => boolean,
): boolean => {
  const normalized = vaultAddress.toLowerCase()
  return pairs.some(pair => pair.borrow.address.toLowerCase() === normalized && isCollateralListed(pair.collateral.address))
}
