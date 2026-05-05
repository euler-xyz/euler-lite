import {
  EVault,
  EulerEarn,
  SecuritizeCollateralVault,
  type EVaultCollateral,
  type EVaultHookedOperations,
  type EVaultHooks,
  type AdaptiveCurveIRMInfo,
  type FixedCyclicalBinaryIRMInfo,
  type EulerEarnStrategyInfo,
  type InterestRates,
  type KinkIRMInfo,
  type KinkyIRMInfo,
  type VaultEntity,
} from '@eulerxyz/euler-v2-sdk'

export { EVault, EulerEarn, SecuritizeCollateralVault }
export type {
  AdaptiveCurveIRMInfo,
  EVaultCollateral,
  EVaultHookedOperations,
  EVaultHooks,
  FixedCyclicalBinaryIRMInfo,
  EulerEarnStrategyInfo,
  InterestRates,
  KinkIRMInfo,
  KinkyIRMInfo,
  VaultEntity,
}
export interface VaultAsset {
  address: `0x${string}`
  name: string
  symbol: string
  decimals: number
  logoURI?: string
}

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

// Union type for combined borrow lists: regular EVault collateral plus
// Securitize collateral shown through a borrow EVault.
export type AnyBorrowVaultPair = BorrowVaultPair | SecuritizeBorrowVaultPair

// Type guard to check if a pair uses Securitize collateral.
export const isSecuritizeBorrowPair = (pair: AnyBorrowVaultPair): pair is SecuritizeBorrowVaultPair =>
  pair.collateral.type === 'SecuritizeCollateral'

// Type guard to narrow the SDK vault union to an EVault.
export const isEVault = (vault: EVault | EulerEarn | SecuritizeCollateralVault): vault is EVault =>
  vault instanceof EVault || vault.type === 'EVault'

export interface VaultIteratorResult<T> {
  vaults: T[]
  isFinished: boolean
}

export interface CollateralOption {
  type: string
  amount: number
  price: number
  apy?: number
  symbol?: string
  assetAddress?: string
  vaultAddress?: string
  tags?: string[]
  disabled?: boolean
  vault?: VaultEntity
  label?: string
}
