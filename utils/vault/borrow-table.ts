import { isEVault, type EVault } from '@eulerxyz/euler-v2-sdk'
import { isSecuritizeBorrowPair, type AnyBorrowVaultPair } from '~/types/borrow-pair'
import type { AnyVault } from '~/composables/useVaultRegistry'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { isVaultDeprecated, isVaultNotExplorableBorrow, isVaultNotExplorableLend } from '~/utils/eulerLabelsUtils'
import { isOpDisabled, OP_BORROW, OP_DEPOSIT, OP_TRANSFER } from '~/utils/vault-hooks'

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

/** A vault the Lend table lists: open to deposits and lending against a collateral the Borrow table lists. */
export const isLendTableVault = (vault: EVault, pairs: readonly AnyBorrowVaultPair[], showAllLabelEntries: boolean): boolean =>
  (showAllLabelEntries || !isVaultNotExplorableLend(vault.address))
  && hasBorrowTablePair(vault.address, pairs, address => isBorrowTableCollateral(address, showAllLabelEntries))
  && !isOpDisabled(vault, OP_DEPOSIT)

/** A pair the Borrow table lists. */
export const isBorrowTablePair = (pair: AnyBorrowVaultPair, showAllLabelEntries: boolean): boolean => {
  if (!showAllLabelEntries && isVaultNotExplorableBorrow(pair.borrow.address)) return false
  if (!isBorrowTableCollateral(pair.collateral.address, showAllLabelEntries)) return false
  if (isOpDisabled(pair.borrow, OP_BORROW)) return false
  // Securitize collateral has no EVault hook flags. A fresh deposit needs OP_DEPOSIT, a savings-sourced one
  // OP_TRANSFER: hide only when both are blocked; the form guards the active path.
  return isSecuritizeBorrowPair(pair) || !(isOpDisabled(pair.collateral, OP_DEPOSIT) && isOpDisabled(pair.collateral, OP_TRANSFER))
}

/**
 * Explore lists a market only while one of its shown vaults is in the Lend table or in a Borrow-table pair.
 * A fully deprecated market stays listed, last, so its users can still find it.
 */
export const isExploreListedMarket = (
  vaults: readonly AnyVault[],
  pairs: readonly AnyBorrowVaultPair[],
  showAllLabelEntries: boolean,
): boolean => {
  if (showAllLabelEntries) return true
  if (vaults.length > 0 && vaults.every(vault => isVaultDeprecated(vault.address))) return true
  if (vaults.some(vault => isEVault(vault) && isLendTableVault(vault, pairs, showAllLabelEntries))) return true
  const members = new Set(vaults.map(vault => vault.address.toLowerCase()))
  return pairs.some(pair =>
    (members.has(pair.borrow.address.toLowerCase()) || members.has(pair.collateral.address.toLowerCase()))
    && isBorrowTablePair(pair, showAllLabelEntries))
}
