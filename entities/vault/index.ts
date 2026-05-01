// Types
export type {
  VaultLiabilityPriceInfo,
  VaultCollateralLTV,
  VaultCollateralPrice,
  VaultAsset,
  VaultInterestRateInfo,
  VaultIRMInfo,
  KinkIRMParams,
  AdaptiveCurveIRMParams,
  KinkyIRMParams,
  CyclicalNoteInfo,
  Erc4626Vault,
  SecuritizeVault,
  Vault,
  BorrowVaultPair,
  SecuritizeBorrowVaultPair,
  AnyBorrowVaultPair,
  VaultIteratorResult,
  EarnVaultStrategyInfo,
  EarnVault,
  CollateralOption,
} from './types'
export { isSecuritizeBorrowPair, isEVKVault } from './types'

// Factory detection — imported directly from ~/entities/vault/factory to avoid circular dependency
// (factory.ts → useVaultRegistry → index.ts → factory.ts)

// Fetchers
export {
  fetchVault,
  fetchSecuritizeVault,
  fetchEarnVault,
  fetchVaults,
  fetchEarnVaults,
} from './fetcher'

// Pricing
export { clearPriceCaches } from './pricing'

// Escrow fetchers
export {
  fetchEscrowVault,
  fetchEscrowAddresses,
} from './escrow-fetcher'

// Shared context for pure fetchers
export type { FetchVaultContext } from './fetcher'

// Universal chain snapshot loader (used by /api/vaults handler and client hydration).
export { loadChainSnapshot } from './loader'
export type { ChainVaultsSnapshot, LoadSnapshotInput } from './loader'
export { serialiseSnapshot, deserialiseSnapshot } from './loader-serde'
export type { SerialisedSnapshot } from './loader-serde'

// LTV ramp calculations
export {
  getCurrentLiquidationLTV,
  isLiquidationLTVRamping,
  isLiveCollateralEdge,
  getRampTimeRemaining,
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
  getUtilization,
  getVaultUtilization,
  getSupplyCapPercentage,
  getBorrowCapPercentage,
  isCyclicalNoteVault,
} from './utils'
