export {
  // Types
  type PriceResult,
  type PriceSource,
  type BackendConfig,
  type UsdAmount,
  toUsdAmount,

  // Constants
  ONE_18,

  // Layer 1: Raw Oracle Prices (Unit of Account) - always on-chain
  getAssetOraclePrice,
  getCollateralShareOraclePrice,
  getCollateralOraclePrice,
  getUnitOfAccountUsdRate,

  // Layer 2: USD Price Info (async, supports backend)
  getAssetUsdPrice,
  getCollateralUsdPrice,

  // Layer 3: USD Value Calculation (async, supports backend)
  getAssetUsdValue,
  getCollateralUsdValue,
  getAssetUsdValueOrZero,
  getCollateralUsdValueOrZero,
  formatAssetValue,

  // Price ratio helpers (conservative: collateral.bid / liability.ask)
  conservativePriceRatio,
  conservativePriceRatioNumber,
  calculateLiquidationRatio,
} from './priceProvider'

// Backend client exports
export {
  configureBackend,
  isBackendConfigured,
  clearStaleBackendCache,
  clearBackendCache,
  fetchBackendPrice,
  fetchBackendPrices,
  backendPriceToBigInt,
  type BackendPriceData,
} from './backendClient'
