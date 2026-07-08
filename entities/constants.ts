import type { Address } from 'viem'
import { EVC_ERROR_SIGNATURES } from './evc-error-signatures'

export const ERROR_MESSAGE_MAP: Record<string, string> = {
  E_SupplyCapExceeded: 'Supply cap reached for this vault.',
  E_BorrowCapExceeded: 'Borrow cap reached for this vault.',
  E_BadSupplyCap: 'Supply cap is invalid.',
  E_BadBorrowCap: 'Borrow cap is invalid.',
  E_AccountLiquidity: 'Account liquidity too low for this action.',
  E_InsufficientBalance: 'Not enough balance for this operation.',
  E_InsufficientCash: 'Not enough liquidity in the vault.',
  E_NotEnoughLiquidity: 'Not enough liquidity in the vault.',
  NotEnoughLiquidity: 'Not enough liquidity in the vault.',
  E_TransferFromFailed: 'Token transfer failed.',
  ERC4626ExceededMaxDeposit: 'Deposit exceeds vault limits.',
  ERC4626ExceededMaxMint: 'Mint exceeds vault limits.',
  ERC4626ExceededMaxWithdraw: 'Withdraw exceeds vault limits.',
  ERC4626ExceededMaxRedeem: 'Redeem exceeds vault limits.',
  SlippageExceeded: 'Slippage exceeded your tolerance. Increase slippage tolerance or refresh the quote.',
  HealthFactorLowerThanLiquidationThreshold: 'Aave account health factor would be below the liquidation threshold.',
  Swapper_SwapError: 'Swap failed. Try increasing slippage tolerance, refreshing the quote, or selecting a different swap provider.',
  Swapper_UnknownHandler: 'Swap provider is not registered. Try selecting a different swap provider.',
  SwapVerifier_skimMin: 'Swap received less than the minimum amount. Increase slippage tolerance or refresh the quote.',
  SwapVerifier_depositMin: 'Swap deposited less than the minimum amount. Increase slippage tolerance or refresh the quote.',
  SwapVerifier_transferMin: 'Swap transferred less than the minimum amount. Increase slippage tolerance or refresh the quote.',
  SwapVerifier_debtMax: 'Swap repaid less debt than required. Increase slippage tolerance or refresh the quote.',
  SwapVerifier_pastDeadline: 'Swap quote expired before execution. Refresh the quote and try again.',
  INSUFFICIENT_BALANCE: 'Insufficient balance.',
  INSUFFICIENT_ALLOWANCE: 'Insufficient allowance.',
  TRANSFER_FROM_FAILED: 'Token transfer failed.',
  TRANSFER_FAILED: 'Token transfer failed.',
  SAFE_TRANSFER_FAILED: 'Token transfer failed.',
  SAFE_TRANSFER_FROM_FAILED: 'Token transfer failed.',
}

export const ERROR_SIGNATURE_MAP: Record<string, string> = {
  ...EVC_ERROR_SIGNATURES,
  '0x6679996d': 'HealthFactorLowerThanLiquidationThreshold',
}

export const TTL_INFINITY = BigInt(
  '0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
)
export const TTL_MORE_THAN_ONE_YEAR = TTL_INFINITY - BigInt(1)
export const TTL_LIQUIDATION = -BigInt(1)
export const TTL_ERROR = -BigInt(2)

export { CACHE_TTL_15S_MS as DEFAULT_PRICE_CACHE_TTL_MS } from './tuning-constants'
export const EXCLUDED_SWAP_PROVIDERS = new Set<string>()
export const SWAP_DEFAULT_DEADLINE_SECONDS = 1800
export const SLIPPAGE_STORAGE_KEY = 'swap-slippage'
export const PERMIT2_PREFERENCE_STORAGE_KEY = 'permit2-enabled'
export const SHOW_ALL_HINT_DISMISSED_KEY = 'show-all-hint-dismissed'
export const DEFAULT_SLIPPAGE = 0.3
export const DEFAULT_STABLECOIN_SLIPPAGE = 0.05
export const SLIPPAGE_EXPIRY_MS = 24 * 60 * 60 * 1000
export const SLIPPAGE_TIMESTAMP_STORAGE_KEY = 'swap-slippage-set-at'
export const MIN_SLIPPAGE = 0.01
export const MAX_SLIPPAGE = 50
export const HIGH_SLIPPAGE_THRESHOLD = 5

export const USD_ADDRESS: Address = '0x0000000000000000000000000000000000000348'
export const EUR_ADDRESS: Address = '0x00000000000000000000000000000000000003d2'
export const BTC_ADDRESS: Address = '0xbBbBBBBbbBBBbbbBbbBbbbbBBbBbbbbBbBbbBBbB'
export const ETH_ADDRESS: Address = '0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE'

// ERC-20 allowance slot candidates checked during simulation state-override probing.
// Sequential range (0..ALLOWANCE_MAX_SEQUENTIAL_SLOT) covers standard ERC-20 layouts
// and OZ Upgradeable tokens where inherited contracts shift the base slot index.
// Tokens using unstructured/namespaced storage (ERC-7201) won't be found by sequential
// probing — simulation falls back to the non-blocking error path for those.
// ALLOWANCE_EXTRA_SLOT_CANDIDATES holds non-sequential slots for known exotic layouts.
export const ALLOWANCE_MAX_SEQUENTIAL_SLOT = 20
export const ALLOWANCE_EXTRA_SLOT_CANDIDATES: bigint[] = []
export const PERMIT2_SIG_WINDOW = 60n * 60n

export const INTEREST_RATE_MODEL_TYPE = {
  KINK: 1,
  ADAPTIVE_CURVE: 2,
  KINKY: 3,
  FIXED_CYCLICAL_BINARY: 4,
  FIXED_CYCLICAL_BINARY_MONTHLY: 5,
} as const

// EVK Vault.configFlags is a bitmask. CFG_DONT_SOCIALIZE_DEBT is the only
// publicly-defined bit today (0x01) — when set, bad debt is left in the vault
// rather than being shared across depositors via share-price reduction.
export const CFG_DONT_SOCIALIZE_DEBT = 1n

export const KINK_IRM_COMPONENTS = [
  { name: 'baseRate', type: 'uint256' },
  { name: 'slope1', type: 'uint256' },
  { name: 'slope2', type: 'uint256' },
  { name: 'kink', type: 'uint256' },
] as const

export const ADAPTIVE_CURVE_IRM_COMPONENTS = [
  { name: 'targetUtilization', type: 'int256' },
  { name: 'initialRateAtTarget', type: 'int256' },
  { name: 'minRateAtTarget', type: 'int256' },
  { name: 'maxRateAtTarget', type: 'int256' },
  { name: 'curveSteepness', type: 'int256' },
  { name: 'adjustmentSpeed', type: 'int256' },
] as const

export const KINKY_IRM_COMPONENTS = [
  { name: 'baseRate', type: 'uint256' },
  { name: 'slope', type: 'uint256' },
  { name: 'shape', type: 'uint256' },
  { name: 'kink', type: 'uint256' },
  { name: 'cutoff', type: 'uint256' },
] as const

export const FIXED_CYCLICAL_BINARY_IRM_COMPONENTS = [
  { name: 'primaryRate', type: 'uint256' },
  { name: 'secondaryRate', type: 'uint256' },
  { name: 'primaryDuration', type: 'uint256' },
  { name: 'secondaryDuration', type: 'uint256' },
  { name: 'startTimestamp', type: 'uint256' },
] as const

export const ORACLE_DETAILED_INFO_COMPONENTS = [
  { name: 'oracle', type: 'address' },
  { name: 'name', type: 'string' },
  { name: 'oracleInfo', type: 'bytes' },
] as const

export const EULER_ROUTER_COMPONENTS = [
  { name: 'governor', type: 'address' },
  { name: 'fallbackOracle', type: 'address' },
  { name: 'fallbackOracleInfo', type: 'tuple', components: ORACLE_DETAILED_INFO_COMPONENTS },
  { name: 'bases', type: 'address[]' },
  { name: 'quotes', type: 'address[]' },
  { name: 'resolvedAssets', type: 'address[][]' },
  { name: 'resolvedOracles', type: 'address[]' },
  { name: 'resolvedOraclesInfo', type: 'tuple[]', components: ORACLE_DETAILED_INFO_COMPONENTS },
] as const

export const CROSS_ADAPTER_COMPONENTS = [
  { name: 'base', type: 'address' },
  { name: 'cross', type: 'address' },
  { name: 'quote', type: 'address' },
  { name: 'oracleBaseCross', type: 'address' },
  { name: 'oracleCrossQuote', type: 'address' },
  { name: 'oracleBaseCrossInfo', type: 'tuple', components: ORACLE_DETAILED_INFO_COMPONENTS },
  { name: 'oracleCrossQuoteInfo', type: 'tuple', components: ORACLE_DETAILED_INFO_COMPONENTS },
] as const

export const PYTH_ORACLE_COMPONENTS = [
  { name: 'pyth', type: 'address' },
  { name: 'base', type: 'address' },
  { name: 'quote', type: 'address' },
  { name: 'feedId', type: 'bytes32' },
  { name: 'maxStaleness', type: 'uint256' },
  { name: 'maxConfWidth', type: 'uint256' },
] as const

// Gregorian year (365.2425 * 86400). Matches EVK/Lens SECONDS_PER_YEAR used by
// on-chain APY math, so display values round-trip exactly with contract output.
export const SECONDS_IN_YEAR = 31_556_952
export const TARGET_TIME_AGO = 3600

export const PERMIT2_TYPES = {
  PermitDetails: [
    { name: 'token', type: 'address' },
    { name: 'amount', type: 'uint160' },
    { name: 'expiration', type: 'uint48' },
    { name: 'nonce', type: 'uint48' },
  ],
  PermitSingle: [
    { name: 'details', type: 'PermitDetails' },
    { name: 'spender', type: 'address' },
    { name: 'sigDeadline', type: 'uint256' },
  ],
} as const

export const MAX_UINT48 = (1n << 48n) - 1n
export const MAX_UINT160 = (1n << 160n) - 1n

export const MERKL_API_BASE_URL = 'https://api.merkl.xyz/v4'
export const DEFILLAMA_YIELDS_URL = 'https://yields.llama.fi/pools'
export const SECURITIZE_FEED_URL = 'https://public-feed.securitize.io/asset-stats'
export const STABLEWATCH_SOURCE_URL = 'https://stablewatch.io'

// Re-export geo-blocking constants (separated to avoid pulling BigInt into server builds)
export { SANCTIONED_COUNTRIES, EU_COUNTRIES, EEA_COUNTRIES, EFTA_COUNTRIES, COUNTRY_GROUPS } from './country-constants'
