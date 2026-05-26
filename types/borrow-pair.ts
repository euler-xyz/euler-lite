import { isSecuritizeCollateralVault, type EVault, type EVaultCollateral, type SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'

export interface BorrowVaultPair {
  borrow: EVault
  collateral: EVault
  ltv: EVaultCollateral
}

export interface SecuritizeBorrowVaultPair {
  borrow: EVault
  collateral: SecuritizeCollateralVault
  ltv: EVaultCollateral
}

export type AnyBorrowVaultPair = BorrowVaultPair | SecuritizeBorrowVaultPair

export const isSecuritizeBorrowPair = (pair: AnyBorrowVaultPair): pair is SecuritizeBorrowVaultPair =>
  isSecuritizeCollateralVault(pair.collateral)
