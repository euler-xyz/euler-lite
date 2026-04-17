import {
  fetchBackendPrice,
  backendPriceToBigInt,
  isBackendConfigured,
  type BackendPriceData,
} from './backendClient'
import { USD_ADDRESS } from '~/entities/constants'
import type {
  Vault,
  EarnVault,
  SecuritizeVault,
  VaultCollateralPrice,
} from '~/entities/vault'
import { nanoToValue } from '~/utils/crypto-utils'
import { formatSmartAmount } from '~/utils/string-utils'

// Union type for all vault types that can be priced
type AnyVault = Vault | EarnVault | SecuritizeVault

export const ONE_18 = 10n ** 18n

// Note: UoA price caching is handled in entities/vault.ts (unitOfAccountPriceCache)
// which caches during vault loading. No separate cache needed here.

/**
 * Price result with mid, ask, and bid prices.
 * All values are in 18-decimal fixed point format.
 */
export type PriceResult = {
  amountOutMid: bigint
  amountOutAsk: bigint
  amountOutBid: bigint
}

export type UsdAmount = {
  usd: number
  hasPrice: boolean
}

export const toUsdAmount = (value: number | undefined): UsdAmount => ({
  usd: value ?? 0,
  hasPrice: value !== undefined,
})

export type PriceSource = 'on-chain' | 'off-chain'

/**
 * Backend fetch configuration.
 * Pass this to price functions to enable backend price fetching.
 */
export type BackendConfig = {
  /** Backend API endpoint URL. Empty string or undefined = disabled */
  url: string | undefined
  /** Chain ID for the request */
  chainId?: number
}

// -------------------------------------------
// Layer 1: Raw Oracle Prices (Unit of Account)
// These are always on-chain - no backend option
// -------------------------------------------

/**
 * Get raw oracle price for a vault's asset in the vault's unit of account.
 * Uses liabilityPriceInfo from the vault lens.
 *
 * @param vault - The vault to get the asset price for
 * @returns PriceResult in unit of account, or undefined if no valid price
 */
export const getAssetOraclePrice = (vault: Vault | null | undefined): PriceResult | undefined => {
  if (!vault) return undefined

  if (!vault.liabilityPriceInfo || vault.liabilityPriceInfo.queryFailure) {
    return undefined
  }

  const { amountOutAsk, amountOutBid, amountOutMid } = vault.liabilityPriceInfo
  if (amountOutMid === undefined || amountOutMid === null) {
    return undefined
  }

  const ask = amountOutAsk && amountOutAsk > 0n ? amountOutAsk : amountOutMid
  const bid = amountOutBid && amountOutBid > 0n ? amountOutBid : amountOutMid

  return { amountOutAsk: ask, amountOutBid: bid, amountOutMid }
}

/**
 * Get collateral share price from the liability vault's perspective.
 * Returns price in the liability vault's unit of account.
 *
 * @param liabilityVault - The borrow vault that defines the collateral relationship
 * @param collateralVault - The collateral vault
 * @returns VaultCollateralPrice in unit of account, or undefined
 */
export const getCollateralShareOraclePrice = (
  liabilityVault: Vault | null | undefined,
  collateralVault: Vault | SecuritizeVault | null | undefined,
): VaultCollateralPrice | undefined => {
  if (!liabilityVault || !collateralVault) return undefined
  const collateralAddress = collateralVault.address.toLowerCase()

  const priceInfo = liabilityVault.collateralPrices.find(
    p => p.asset.toLowerCase() === collateralAddress,
  )

  if (!priceInfo) {
    return undefined
  }

  // Return price if available, even if queryFailure is true
  // (queryFailure may indicate stale price but we can still use it)
  if (priceInfo.queryFailure && !priceInfo.amountOutMid) {
    return undefined
  }

  return priceInfo
}

/**
 * Get collateral ASSET price from the liability vault's perspective.
 * Converts share price to asset price using totalShares/totalAssets.
 * Returns price in the liability vault's unit of account.
 *
 * @param liabilityVault - The borrow vault that defines the collateral relationship
 * @param collateralVault - The collateral vault
 * @returns PriceResult in unit of account, or undefined
 */
export const getCollateralOraclePrice = (
  liabilityVault: Vault | null | undefined,
  collateralVault: Vault | SecuritizeVault | null | undefined,
): PriceResult | undefined => {
  if (!liabilityVault || !collateralVault) {
    return undefined
  }

  const sharePrice = getCollateralShareOraclePrice(liabilityVault, collateralVault)

  if (!sharePrice) {
    return undefined
  }

  const { totalAssets, totalShares } = collateralVault

  // For empty vaults (totalAssets = 0 and totalShares = 0), ERC-4626 standard
  // defines 1:1 ratio between shares and assets. Use share price directly.
  if (totalAssets === 0n && totalShares === 0n) {
    const mid = sharePrice.amountOutMid
    const ask = sharePrice.amountOutAsk && sharePrice.amountOutAsk > 0n ? sharePrice.amountOutAsk : mid
    const bid = sharePrice.amountOutBid && sharePrice.amountOutBid > 0n ? sharePrice.amountOutBid : mid
    return { amountOutAsk: ask, amountOutBid: bid, amountOutMid: mid }
  }

  if (totalAssets === 0n) {
    // totalAssets is 0 but totalShares > 0 - unusual state, can't calculate
    return undefined
  }

  // assetPrice = sharePrice × (totalShares / totalAssets)
  const amountOutMid = (sharePrice.amountOutMid * totalShares) / totalAssets
  const amountOutAsk = (sharePrice.amountOutAsk * totalShares) / totalAssets
  const amountOutBid = (sharePrice.amountOutBid * totalShares) / totalAssets

  // Note: 0n is a valid price (very small value due to precision), don't reject it
  const ask = amountOutAsk > 0n ? amountOutAsk : amountOutMid
  const bid = amountOutBid > 0n ? amountOutBid : amountOutMid

  return { amountOutAsk: ask, amountOutBid: bid, amountOutMid }
}

/**
 * Get the USD rate for a vault's unit of account (on-chain only, internal helper).
 *
 * @param vault - The vault to get the UoA rate for
 * @returns UoA → USD rate as bigint (18 decimals), or undefined
 */
const getUnitOfAccountUsdRateOnChain = (vault: Vault | null | undefined): bigint | undefined => {
  if (!vault || !vault.unitOfAccount) {
    return undefined
  }

  // Special case: USD unit of account returns 1.0
  if (vault.unitOfAccount.toLowerCase() === USD_ADDRESS.toLowerCase()) {
    return ONE_18
  }

  // Use cached unitOfAccountPriceInfo (fetched during vault loading)
  if (!vault.unitOfAccountPriceInfo?.amountOutMid) {
    return undefined
  }

  return vault.unitOfAccountPriceInfo.amountOutMid
}

/**
 * Get the USD rate for a vault's unit of account.
 * Returns 1.0 (as 1e18) if unit of account is USD.
 *
 * Always tries backend (off-chain) first, then falls back to on-chain.
 * UoA is a common denominator in calculations — using off-chain rates
 * doesn't affect health factor/LTV ratios, only USD display values.
 *
 * @param vault - The vault to get the UoA rate for
 * @returns UoA → USD rate as bigint (18 decimals), or undefined
 */
export const getUnitOfAccountUsdRate = async (
  vault: Vault | null | undefined,
): Promise<bigint | undefined> => {
  if (!vault || !vault.unitOfAccount) {
    return undefined
  }

  // Special case: USD unit of account returns 1.0
  if (vault.unitOfAccount.toLowerCase() === USD_ADDRESS.toLowerCase()) {
    return ONE_18
  }

  // Always try backend first (UoA is a common denominator, doesn't affect ratios)
  if (isBackendConfigured()) {
    try {
      const backendPrice = await fetchBackendPrice(
        vault.unitOfAccount as `0x${string}`,
      )
      if (backendPrice) {
        const rate = backendPriceToBigInt(backendPrice.price)
        if (rate > 0n) return rate
      }
    }
    catch {
      // Fall through to on-chain
    }
  }

  return getUnitOfAccountUsdRateOnChain(vault)
}

// -------------------------------------------
// Layer 2: USD Price Info
// -------------------------------------------

/**
 * Determine if vault is an EarnVault (type === 'earn').
 */
const isEarnVault = (vault: AnyVault | null | undefined): vault is EarnVault => {
  return vault != null && 'type' in vault && vault.type === 'earn'
}

/**
 * Determine if vault is a Securitize vault (type === 'securitize').
 */
const isSecuritizeVault = (vault: AnyVault | null | undefined): vault is SecuritizeVault => {
  return vault != null && 'type' in vault && vault.type === 'securitize'
}

/**
 * Determine if vault is an Escrow vault (vaultCategory === 'escrow').
 */
const isEscrowVault = (vault: AnyVault | null | undefined): boolean => {
  return vault != null && 'vaultCategory' in vault && vault.vaultCategory === 'escrow'
}

/**
 * Determine if vault uses UtilsLens for pricing (escrow, securitize, or earn vaults).
 * These vaults use assetPriceInfo which is already in USD.
 */
const usesUtilsLensPricing = (vault: AnyVault | null | undefined): boolean => {
  if (!vault) return false
  return isEarnVault(vault) || isEscrowVault(vault) || isSecuritizeVault(vault)
}

/**
 * Convert backend price data to PriceResult format.
 */
const backendPriceToPriceResult = (data: BackendPriceData): PriceResult | undefined => {
  const mid = backendPriceToBigInt(data.price)
  if (mid <= 0n) return undefined
  return { amountOutMid: mid, amountOutAsk: mid, amountOutBid: mid }
}

/**
 * Get asset price in USD using on-chain oracle + UoA conversion.
 * UoA rate can still come from backend if source is 'off-chain'.
 */
const getAssetUsdPriceFromOracle = async (
  vault: AnyVault | null | undefined,
  _source: PriceSource,
  _backend?: BackendConfig,
): Promise<PriceResult | undefined> => {
  if (!vault) return undefined

  // Earn/Escrow/Securitize vaults - use UtilsLens (assetPriceInfo is already in USD)
  if (usesUtilsLensPricing(vault)) {
    const priceInfo = (vault as Vault | EarnVault | SecuritizeVault).assetPriceInfo
    if (priceInfo?.amountOutMid) {
      const mid = priceInfo.amountOutMid
      return { amountOutMid: mid, amountOutAsk: mid, amountOutBid: mid }
    }
    return undefined
  }

  // Regular EVK vaults - use oracle router (liabilityPriceInfo + UoA conversion)
  const oraclePrice = getAssetOraclePrice(vault as Vault)
  if (!oraclePrice) return undefined

  const uoaRate = await getUnitOfAccountUsdRate(vault as Vault)
  if (!uoaRate) return undefined

  return {
    amountOutMid: (oraclePrice.amountOutMid * uoaRate) / ONE_18,
    amountOutAsk: (oraclePrice.amountOutAsk * uoaRate) / ONE_18,
    amountOutBid: (oraclePrice.amountOutBid * uoaRate) / ONE_18,
  }
}

/**
 * Get collateral price in USD using on-chain oracle + UoA conversion.
 * UoA rate can still come from backend if source is 'off-chain'.
 */
const getCollateralUsdPriceFromOracle = async (
  liabilityVault: Vault | null | undefined,
  collateralVault: Vault | SecuritizeVault | null | undefined,
  _source: PriceSource,
  _backend?: BackendConfig,
): Promise<PriceResult | undefined> => {
  if (!liabilityVault || !collateralVault) return undefined

  // Use liability vault's oracle for collateral pricing
  const oraclePrice = getCollateralOraclePrice(liabilityVault, collateralVault)
  if (!oraclePrice) return undefined

  // Convert using liability vault's UoA (the collateral price is in liability's UoA)
  const uoaRate = await getUnitOfAccountUsdRate(liabilityVault)
  if (!uoaRate) return undefined

  return {
    amountOutMid: (oraclePrice.amountOutMid * uoaRate) / ONE_18,
    amountOutAsk: (oraclePrice.amountOutAsk * uoaRate) / ONE_18,
    amountOutBid: (oraclePrice.amountOutBid * uoaRate) / ONE_18,
  }
}

/**
 * Get asset price in USD.
 *
 * @param vault - The vault to get the USD price for
 * @param source - Price source: 'on-chain' (default) or 'off-chain' (tries backend first)
 * @param backend - Backend configuration (required for 'off-chain' source)
 * @returns PriceResult in USD, or undefined
 */
export const getAssetUsdPrice = async (
  vault: AnyVault | null | undefined,
  source: PriceSource = 'on-chain',
  backend?: BackendConfig,
): Promise<PriceResult | undefined> => {
  if (!vault) return undefined

  // Try backend first if configured and source is 'off-chain'
  if (source === 'off-chain' && isBackendConfigured()) {
    try {
      const backendPrice = await fetchBackendPrice(
        vault.asset.address as `0x${string}`,
        backend?.chainId,
      )
      if (backendPrice) {
        const result = backendPriceToPriceResult(backendPrice)
        if (result) return result
      }
    }
    catch {
      // Fall through to oracle calculation
    }
  }

  // Oracle calculation (UoA rate can still use backend for 'off-chain' source)
  return getAssetUsdPriceFromOracle(vault, source, backend)
}

/**
 * Get collateral price in USD in the context of a liability vault.
 *
 * Note: Collateral pricing ALWAYS uses the liability vault's oracle,
 * regardless of collateral vault type (even for escrow collaterals).
 *
 * For liquidation-sensitive calculations, use source='on-chain'.
 *
 * @param liabilityVault - The borrow vault that defines the collateral relationship
 * @param collateralVault - The collateral vault
 * @param source - Price source: 'on-chain' (default) or 'off-chain' (tries backend first)
 * @param backend - Backend configuration (required for 'off-chain' source)
 * @returns PriceResult in USD, or undefined
 */
export const getCollateralUsdPrice = async (
  liabilityVault: Vault | null | undefined,
  collateralVault: Vault | SecuritizeVault | null | undefined,
  source: PriceSource = 'on-chain',
  backend?: BackendConfig,
): Promise<PriceResult | undefined> => {
  if (!liabilityVault || !collateralVault) return undefined

  // Try backend first if configured and source is 'off-chain'
  // Use fetchBackendPrice directly with the collateral asset address
  // (the /v1/prices endpoint returns asset prices without needing liability context)
  if (source === 'off-chain' && isBackendConfigured()) {
    try {
      const backendPrice = await fetchBackendPrice(
        collateralVault.asset.address as `0x${string}`,
        backend?.chainId,
      )
      if (backendPrice) {
        const result = backendPriceToPriceResult(backendPrice)
        if (result) return result
      }
    }
    catch {
      // Fall through to oracle calculation
    }
  }

  // Oracle calculation (UoA rate can still use backend for 'off-chain' source)
  return getCollateralUsdPriceFromOracle(liabilityVault, collateralVault, source, backend)
}

// -------------------------------------------
// Layer 3: USD Value Calculation
// -------------------------------------------

/**
 * Calculate USD value of an asset amount.
 *
 * @param amount - Amount as bigint (native decimals) or number (token amount)
 * @param vault - The vault
 * @param source - Price source: 'on-chain' (default) or 'off-chain'
 * @param backend - Backend configuration (required for 'off-chain' source)
 * @returns USD value as number, or undefined if no price available
 */
export const getAssetUsdValue = async (
  amount: number | bigint,
  vault: AnyVault | null | undefined,
  source: PriceSource = 'on-chain',
  backend?: BackendConfig,
): Promise<number | undefined> => {
  if (!vault) return undefined

  const price = await getAssetUsdPrice(vault, source, backend)
  if (!price) return undefined

  const tokenAmount = typeof amount === 'bigint' ? nanoToValue(amount, vault.decimals) : amount
  const usdPrice = nanoToValue(price.amountOutMid, 18)
  return tokenAmount * usdPrice
}

/**
 * Calculate USD value of collateral amount in liability context.
 *
 * @param assetAmount - Amount in assets (NOT shares), in native token decimals
 * @param liabilityVault - The borrow vault that defines the collateral relationship
 * @param collateralVault - The collateral vault
 * @param source - Price source: 'on-chain' (default) or 'off-chain'
 * @param backend - Backend configuration (required for 'off-chain' source)
 * @returns USD value as number, or undefined if no price available
 */
export const getCollateralUsdValue = async (
  assetAmount: bigint,
  liabilityVault: Vault | null | undefined,
  collateralVault: Vault | SecuritizeVault | null | undefined,
  source: PriceSource = 'on-chain',
  backend?: BackendConfig,
): Promise<number | undefined> => {
  if (!liabilityVault || !collateralVault) return undefined

  const price = await getCollateralUsdPrice(liabilityVault, collateralVault, source, backend)
  if (!price) return undefined

  const tokenAmount = nanoToValue(assetAmount, collateralVault.decimals)
  const usdPrice = nanoToValue(price.amountOutMid, 18)
  return tokenAmount * usdPrice
}

/**
 * Convenience wrapper: same as getAssetUsdValue but returns 0 instead of undefined.
 */
export const getAssetUsdValueOrZero = async (
  ...args: Parameters<typeof getAssetUsdValue>
): Promise<number> => {
  return (await getAssetUsdValue(...args)) ?? 0
}

/**
 * Calculate USD value of a token amount, preferring vault pricing when
 * available and falling back to the backend price feed for tokens without
 * an associated vault (e.g. arbitrary swap tokens from the wallet).
 *
 * @param amount - Token amount in native decimals
 * @param decimals - Token decimals
 * @param tokenAddress - Token address, required for backend fallback
 * @param vault - Optional vault for on-vault pricing
 * @returns USD value as number, or undefined if no price available
 */
export const getTokenUsdValue = async (
  amount: bigint,
  decimals: number,
  tokenAddress: string,
  vault: AnyVault | null | undefined,
): Promise<number | undefined> => {
  if (vault) {
    return getAssetUsdValue(amount, vault, 'off-chain')
  }
  const priceData = await fetchBackendPrice(tokenAddress as `0x${string}`)
  if (!priceData?.price) return undefined
  const tokenAmount = nanoToValue(amount, decimals)
  return tokenAmount * priceData.price
}

/**
 * Convenience wrapper: same as getCollateralUsdValue but returns 0 instead of undefined.
 */
export const getCollateralUsdValueOrZero = async (
  ...args: Parameters<typeof getCollateralUsdValue>
): Promise<number> => {
  return (await getCollateralUsdValue(...args)) ?? 0
}

/**
 * Format asset value for UI display.
 *
 * @param amount - Amount in native token decimals (bigint) or as number
 * @param vault - The vault
 * @param source - Price source: 'on-chain' (default) or 'off-chain'
 * @param backend - Backend configuration (required for 'off-chain' source)
 * @param options - Formatting options
 * @returns Object with display string, hasPrice flag, USD value, and asset info
 */
export const formatAssetValue = async (
  amount: number | bigint,
  vault: AnyVault | null | undefined,
  source: PriceSource = 'on-chain',
  backend?: BackendConfig,
  options: { maxDecimals?: number, minDecimals?: number } = {},
): Promise<{ display: string, hasPrice: boolean, usdValue: number, assetAmount: number, assetSymbol: string }> => {
  const { maxDecimals = 2, minDecimals: _minDecimals = 2 } = options

  if (!vault) {
    return {
      display: '-',
      hasPrice: false,
      usdValue: 0,
      assetAmount: 0,
      assetSymbol: '',
    }
  }

  const actualAmount = typeof amount === 'bigint' ? nanoToValue(amount, vault.decimals) : amount
  const symbol = vault.asset.symbol

  const price = await getAssetUsdPrice(vault, source, backend)

  if (!price) {
    const formattedAmount = formatSmartAmount(actualAmount, maxDecimals)
    return {
      display: `${formattedAmount} ${symbol}`,
      hasPrice: false,
      usdValue: 0,
      assetAmount: actualAmount,
      assetSymbol: symbol,
    }
  }

  const usdValue = actualAmount * nanoToValue(price.amountOutMid, 18)
  return {
    display: '', // Empty - components will format USD themselves
    hasPrice: true,
    usdValue,
    assetAmount: actualAmount,
    assetSymbol: symbol,
  }
}

// -------------------------------------------
// Liquidation Price Calculation Helpers
// -------------------------------------------

/**
 * Conservative oracle price ratio: collateral.bid / liability.ask (18-decimal bigint).
 *
 * Matches EVK on-chain convention in LiquidityUtils.sol:
 *   - Collateral valued at bid (lower — what you'd get selling)
 *   - Liability valued at ask (higher — what you'd spend buying)
 */
export const conservativePriceRatio = (
  collateralPrice: PriceResult | null | undefined,
  liabilityPrice: PriceResult | null | undefined,
): bigint => {
  if (!collateralPrice || !liabilityPrice) return 0n
  const ask = liabilityPrice.amountOutAsk
  if (!ask || ask === 0n) return 0n
  return (collateralPrice.amountOutBid * ONE_18) / ask
}

/**
 * Conservative oracle price ratio as a number (float).
 * Returns null if either price is missing or zero.
 *
 * @see conservativePriceRatio for the bigint version
 */
export const conservativePriceRatioNumber = (
  collateralPrice: PriceResult | null | undefined,
  liabilityPrice: PriceResult | null | undefined,
): number | null => {
  if (!collateralPrice || !liabilityPrice) return null
  const bid = collateralPrice.amountOutBid
  const ask = liabilityPrice.amountOutAsk
  if (!bid || !ask) return null
  return nanoToValue(bid, 18) / nanoToValue(ask, 18)
}

/**
 * Calculate liquidation price ratio in unit of account.
 * This is the ratio at which the collateral/liability price causes liquidation.
 *
 * For displaying liquidation price in USD, multiply the result by UoA rate.
 *
 * @param collateralOraclePrice - Collateral price in UoA
 * @param liabilityOraclePrice - Liability price in UoA
 * @returns Ratio in UoA (UoA cancels in ratio)
 */
export const calculateLiquidationRatio = (
  collateralOraclePrice: PriceResult | null | undefined,
  liabilityOraclePrice: PriceResult | null | undefined,
): bigint => {
  return conservativePriceRatio(collateralOraclePrice, liabilityOraclePrice)
}
