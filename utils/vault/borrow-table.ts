import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { isVaultNotExplorableBorrow } from '~/utils/eulerLabelsUtils'

export const isBorrowTableCollateral = (collateralAddress: string, showAllLabelEntries: boolean): boolean =>
  showAllLabelEntries || !isVaultNotExplorableBorrow(collateralAddress)

/** Lend-table eligibility: a borrowLTV > 0 pair of this vault whose collateral passes `isCollateralListed`. */
export const hasBorrowTablePair = (
  vaultAddress: string,
  pairs: readonly AnyBorrowVaultPair[],
  isCollateralListed: (collateralAddress: string) => boolean,
): boolean => {
  const normalized = vaultAddress.toLowerCase()
  return pairs.some(pair => pair.borrow.address.toLowerCase() === normalized && isCollateralListed(pair.collateral.address))
}
