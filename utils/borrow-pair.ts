import type {
  EVault,
  EVaultCollateral,
  PortfolioBorrowPosition,
  SecuritizeCollateralVault,
  VaultEntity,
} from '@eulerxyz/euler-v2-sdk'
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { getBorrowPositionEffectiveLiquidationLTV } from '~/utils/ltv'

export type BorrowPairLike = AnyBorrowVaultPair | PortfolioBorrowPosition<VaultEntity>

export const isBorrowVaultPair = (value: BorrowPairLike): value is AnyBorrowVaultPair =>
  'ltv' in value

export const getPairBorrowVault = (pair: BorrowPairLike): EVault =>
  isBorrowVaultPair(pair) ? pair.borrow : pair.borrowVault as EVault

export const getPairCollateralVault = (pair: BorrowPairLike): EVault | SecuritizeCollateralVault =>
  isBorrowVaultPair(pair) ? pair.collateral : pair.collateralVault as EVault | SecuritizeCollateralVault

export const getPairBorrowLTV = (pair: BorrowPairLike): number | undefined =>
  isBorrowVaultPair(pair) ? pair.ltv.borrowLTV : pair.borrowLTV

export const getPairCurrentLiquidationLTV = (pair: BorrowPairLike): number | undefined =>
  isBorrowVaultPair(pair) ? pair.ltv.currentLiquidationLTV : getBorrowPositionEffectiveLiquidationLTV(pair)

export const getPairRampConfig = (pair: BorrowPairLike): EVaultCollateral | null =>
  isBorrowVaultPair(pair) ? pair.ltv : null
