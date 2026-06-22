import type {
  EVault,
  EVaultCollateral,
  PortfolioBorrowPosition,
  SecuritizeCollateralVault,
  VaultEntity,
} from '@eulerxyz/euler-v2-sdk'
import { isEVault, isSecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { getBorrowPositionEffectiveLiquidationLTV } from '~/utils/ltv'

export type BorrowPairLike = AnyBorrowVaultPair | PortfolioBorrowPosition<VaultEntity>

export const isBorrowVaultPair = (value: BorrowPairLike): value is AnyBorrowVaultPair =>
  'ltv' in value

export const getPairBorrowVault = (pair: BorrowPairLike): EVault =>
  isBorrowVaultPair(pair) ? pair.borrow : pair.borrowVault as EVault

export const getPairCollateralVault = (pair: BorrowPairLike): EVault | SecuritizeCollateralVault =>
  isBorrowVaultPair(pair) ? pair.collateral : pair.collateralVault as EVault | SecuritizeCollateralVault

export const getPairCollateralVaults = (pair: BorrowPairLike): Array<EVault | SecuritizeCollateralVault> => {
  if (isBorrowVaultPair(pair)) return [pair.collateral]

  const collaterals = pair.collaterals?.flatMap((collateralPosition) => {
    const vault = collateralPosition.vault
    return vault && (isEVault(vault) || isSecuritizeCollateralVault(vault)) ? [vault] : []
  }) ?? []

  return collaterals.length ? collaterals : [getPairCollateralVault(pair)]
}

export const getPairBorrowLTV = (pair: BorrowPairLike): number | undefined =>
  isBorrowVaultPair(pair) ? pair.ltv.borrowLTV : pair.borrowLTV

export const getPairCurrentLiquidationLTV = (pair: BorrowPairLike): number | undefined =>
  isBorrowVaultPair(pair) ? pair.ltv.currentLiquidationLTV : getBorrowPositionEffectiveLiquidationLTV(pair)

/**
 * Resolve the ramp-bearing collateral edge for a pair.
 *
 * Market pairs carry the edge directly as `pair.ltv`. For a live borrow
 * position we have to find the matching edge on `position.borrowVault.collaterals`
 * — without this the ramp indicator never showed on the position page (the
 * arrow + "Ramp details" modal both depend on a non-null ramp config).
 */
export const getPairRampConfig = (pair: BorrowPairLike): EVaultCollateral | null => {
  if (isBorrowVaultPair(pair)) return pair.ltv
  const borrowVault = pair.borrowVault as EVault | undefined
  const collateralAddress = pair.collateralVault?.address
  if (!borrowVault?.collaterals || !collateralAddress) return null
  const lower = collateralAddress.toLowerCase()
  return borrowVault.collaterals.find(c => c.address.toLowerCase() === lower) ?? null
}
