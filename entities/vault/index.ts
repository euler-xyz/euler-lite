// Types
export type {
  EVaultCollateral,
  EVaultHookedOperations,
  EVaultHooks,
  VaultAsset,
  InterestRates,
  KinkIRMInfo,
  AdaptiveCurveIRMInfo,
  KinkyIRMInfo,
  FixedCyclicalBinaryIRMInfo,
  VaultEntity,
  BorrowVaultPair,
  SecuritizeBorrowVaultPair,
  AnyBorrowVaultPair,
  VaultIteratorResult,
  EulerEarnStrategyInfo,
  CollateralOption,
  CollateralOptionType,
} from './types'
export { EVault, EulerEarn, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
export { isSecuritizeBorrowPair, isEVault } from './types'

// Factory detection — imported directly from ~/entities/vault/factory to avoid circular dependency
// (factory.ts → useVaultRegistry → index.ts → factory.ts)

// Pricing
export { clearPriceCaches } from './pricing'

// LTV ramp calculations
export {
  isLiveCollateralEdge,
} from './ltv'

// Collateral discovery (find addresses referenced as live collateral but
// not yet resolved into the registry).
export { extractUnresolvedCollateralAddresses } from './collateral-discovery'

// Collateral exposure (borrow-side pair derivation)
export {
  getCollateralExposurePairs,
  hasCollateralExposure,
} from './collateral-exposure'
export type {
  CollateralExposurePair,
  CollateralVaultResolver,
} from './collateral-exposure'

// APY computations
export {
  computeAPYs,
  getProjectedRates,
  getNetAPY,
  getRoe,
} from './apy'
export type { ProjectedRates } from './apy'

// Utility functions
export {
  getBorrowVaultsByMap,
  getBorrowVaultPairByMapAndAddresses,
  convertSharesToAssets,
  convertAssetsToShares,
  previewWithdraw,
  getMaxWithdraw,
  getCashLimitedWithdrawAmount,
  isCyclicalNoteVault,
} from './utils'
