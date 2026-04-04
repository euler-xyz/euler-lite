// Types
export type {
  VaultLiabilityPriceInfo,
  VaultCollateralLTV,
  VaultCollateralPrice,
  VaultAsset,
  VaultInterestRateInfo,
  VaultIRMInfo,
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
export { isSecuritizeBorrowPair } from './types'

// Factory detection — imported directly from ~/entities/vault/factory to avoid circular dependency
// (factory.ts → useVaultRegistry → index.ts → factory.ts)

// Fetchers
export {
  fetchVault,
  fetchSecuritizeVault,
  fetchEarnVault,
  fetchVaults,
  fetchEarnVaults,
  processRawVaultData,
  processRawEarnVaultData,
  processRawSecuritizeVaultData,
} from './fetcher'

// Pricing
export { clearPriceCaches } from './pricing'

// Escrow fetchers
export {
  fetchEscrowVault,
  fetchEscrowAddresses,
  fetchEscrowVaults,
} from './escrow-fetcher'

// LTV ramp calculations
export {
  getCurrentLiquidationLTV,
  isLiquidationLTVRamping,
  getRampTimeRemaining,
} from './ltv'

// APY computations
export {
  computeAPYs,
  getNetAPY,
  getRoe,
} from './apy'

// Utility functions
export {
  getBorrowVaultsByMap,
  getBorrowVaultPairByMapAndAddresses,
  convertSharesToAssets,
  convertAssetsToShares,
  previewWithdraw,
  getMaxWithdraw,
  getUtilization,
  getVaultUtilization,
} from './utils'
