import {
  getAssetOraclePrice as getSdkAssetOraclePrice,
  getCollateralOraclePrice as getSdkCollateralOraclePrice,
  getCollateralShareOraclePrice as getSdkCollateralShareOraclePrice,
  isEVault,
  type ERC4626Vault,
  type EVault,
  type SecuritizeCollateralVault,
  type OraclePrice,
} from '@eulerxyz/euler-v2-sdk'
import { getAddress, parseUnits, type Address } from 'viem'
import { nanoToValue } from '~/utils/crypto-utils'
import { formatSmartAmount } from '~/utils/string-utils'
import { USD_ADDRESS } from '~/entities/constants'
import { getEulerSdk } from '~/composables/useEulerSdk'

type PriceableVault = {
  address: string
  asset: {
    decimals: number
    symbol: string
  }
  marketPriceUsd?: bigint | number
}

type AnyVault = PriceableVault | ERC4626Vault | EVault | SecuritizeCollateralVault

type CollateralPriceEdge = {
  address: string
  marketPriceUsd?: bigint | number
}

type LiabilityPricedVault = {
  collaterals: CollateralPriceEdge[]
}

type PriceableCollateralVault = {
  address: string
  asset: {
    decimals: number
    symbol: string
  }
}

export const ONE_18 = 10n ** 18n

export type PriceResult = {
  amountOutMid: bigint
  amountOutAsk: bigint
  amountOutBid: bigint
}

export type UsdAmount = {
  usd: number
  hasPrice: boolean
}

export type PriceSource = 'on-chain' | 'off-chain'

export const toUsdAmount = (value: number | undefined): UsdAmount => ({
  usd: value ?? 0,
  hasPrice: value !== undefined,
})

const numberUsdPriceToWad = (price: number): bigint | undefined => {
  if (!Number.isFinite(price) || price < 0) return undefined
  const normalized = price.toLocaleString('en-US', {
    maximumFractionDigits: 18,
    useGrouping: false,
  })
  return parseUnits(normalized, 18)
}

const priceUsdToWad = (price: bigint | number | undefined | null): bigint | undefined => {
  if (price == null) return undefined
  if (typeof price === 'bigint') return price
  return numberUsdPriceToWad(price)
}

const priceWadToResult = (price: bigint | number | undefined | null): PriceResult | undefined => {
  const priceWad = priceUsdToWad(price)
  if (priceWad === undefined) return undefined
  return {
    amountOutMid: priceWad,
    amountOutAsk: priceWad,
    amountOutBid: priceWad,
  }
}

const priceResultToNumber = (price: Pick<PriceResult, 'amountOutMid'> | undefined): number | undefined =>
  price ? nanoToValue(price.amountOutMid, 18) : undefined

const tokenAmountToUsdValue = (
  amount: number | bigint,
  decimals: number,
  price: Pick<PriceResult, 'amountOutMid'> | undefined,
): number | undefined => {
  const unitPrice = priceResultToNumber(price)
  if (unitPrice === undefined) return undefined
  const tokenAmount = typeof amount === 'bigint' ? nanoToValue(amount, decimals) : amount
  return tokenAmount * unitPrice
}

const isUsdUnitOfAccount = (vault: EVault): boolean => {
  const uoa = vault.unitOfAccount?.address
  return !!uoa && getAddress(uoa) === getAddress(USD_ADDRESS)
}

const findCollateralEdge = (
  liabilityVault: LiabilityPricedVault,
  collateralVault: { address: string },
) => {
  const collateralAddress = getAddress(collateralVault.address)
  return liabilityVault.collaterals.find(collateral =>
    getAddress(collateral.address) === collateralAddress,
  )
}

const isFullCollateralVault = (vault: PriceableCollateralVault): vault is ERC4626Vault =>
  'totalAssets' in vault && 'totalShares' in vault

export const getAssetOraclePrice = (vault: EVault | undefined | null): PriceResult | undefined =>
  vault ? getSdkAssetOraclePrice(vault) : undefined

export const getCollateralShareOraclePrice = (
  liabilityVault: EVault | undefined | null,
  collateralVault: { address: string } | undefined | null,
): OraclePrice | undefined =>
  liabilityVault && collateralVault
    ? getSdkCollateralShareOraclePrice(liabilityVault, collateralVault as ERC4626Vault)
    : undefined

export const getCollateralOraclePrice = (
  liabilityVault: EVault | undefined | null,
  collateralVault: ERC4626Vault | undefined | null,
): PriceResult | undefined =>
  liabilityVault && collateralVault
    ? getSdkCollateralOraclePrice(liabilityVault, collateralVault)
    : undefined

const getAssetRiskUsdPrice = async (vault: AnyVault | undefined | null): Promise<PriceResult | undefined> => {
  if (!vault || !isEVault(vault)) return undefined

  const risk = vault.assetRiskPrice
  if (!risk) return undefined
  const uoaUsdRate = await getUnitOfAccountUsdRate(vault)
  if (!uoaUsdRate) return undefined

  return {
    amountOutMid: (risk.priceLiquidation * uoaUsdRate) / ONE_18,
    amountOutAsk: (risk.priceBorrowing * uoaUsdRate) / ONE_18,
    amountOutBid: (risk.priceLiquidation * uoaUsdRate) / ONE_18,
  }
}

const getCollateralRiskUsdPrice = async (
  liabilityVault: EVault | undefined | null,
  collateralVault: ERC4626Vault | undefined | null,
): Promise<PriceResult | undefined> => {
  if (!liabilityVault || !collateralVault) return undefined

  const risk = liabilityVault.getCollateralRiskPrice(collateralVault)
  if (!risk) return undefined
  const uoaUsdRate = await getUnitOfAccountUsdRate(liabilityVault)
  if (!uoaUsdRate) return undefined

  return {
    amountOutMid: (risk.priceLiquidation * uoaUsdRate) / ONE_18,
    amountOutAsk: (risk.priceLiquidation * uoaUsdRate) / ONE_18,
    amountOutBid: (risk.priceBorrowing * uoaUsdRate) / ONE_18,
  }
}

export const getAssetUsdPrice = async (
  vault: AnyVault | null | undefined,
  source: PriceSource = 'off-chain',
): Promise<PriceResult | undefined> => {
  if (!vault) return undefined
  if (source === 'on-chain') {
    return await getAssetRiskUsdPrice(vault)
  }
  return priceWadToResult(vault.marketPriceUsd)
}

export const getCollateralUsdPrice = async (
  liabilityVault: EVault | LiabilityPricedVault | null | undefined,
  collateralVault: ERC4626Vault | PriceableCollateralVault | null | undefined,
  source: PriceSource = 'off-chain',
): Promise<PriceResult | undefined> => {
  if (!liabilityVault || !collateralVault) return undefined
  if (source === 'on-chain') {
    return isEVault(liabilityVault) && isFullCollateralVault(collateralVault)
      ? await getCollateralRiskUsdPrice(liabilityVault, collateralVault)
      : undefined
  }

  const edge = findCollateralEdge(liabilityVault, collateralVault)
  return priceWadToResult(edge?.marketPriceUsd)
}

export const getUnitOfAccountUsdRate = async (
  vault: EVault | null | undefined,
): Promise<bigint | undefined> => {
  if (!vault) return undefined
  if (isUsdUnitOfAccount(vault)) return ONE_18
  const sdk = await getEulerSdk()
  return priceUsdToWad(await vault.fetchUnitOfAccountMarketPriceUsd(sdk.priceService))
}

export const getAssetUsdValue = async (
  amount: number | bigint,
  vault: AnyVault | null | undefined,
  source: PriceSource = 'off-chain',
): Promise<number | undefined> => {
  if (!vault) return undefined
  return tokenAmountToUsdValue(amount, vault.asset.decimals, await getAssetUsdPrice(vault, source))
}

/**
 * Keep projected metrics unavailable when a nonzero amount has no usable USD
 * price, while allowing a genuinely empty leg to contribute $0.
 */
export const getAssetUsdValueForEstimate = async (
  amount: number | bigint,
  vault: AnyVault | null | undefined,
  source: PriceSource = 'off-chain',
): Promise<number | undefined> => {
  if (!vault) return undefined
  if (amount === 0 || amount === 0n) return 0
  const value = await getAssetUsdValue(amount, vault, source)
  return value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined
}

export const getAssetUsdValueOrZero = async (
  ...args: Parameters<typeof getAssetUsdValue>
): Promise<number> => {
  return (await getAssetUsdValue(...args)) ?? 0
}

export const getCollateralUsdValue = async (
  amount: bigint,
  liabilityVault: EVault | LiabilityPricedVault | null | undefined,
  collateralVault: ERC4626Vault | PriceableCollateralVault | null | undefined,
  source: PriceSource = 'off-chain',
): Promise<number | undefined> => {
  if (!collateralVault) return undefined
  return tokenAmountToUsdValue(
    amount,
    collateralVault.asset.decimals,
    await getCollateralUsdPrice(liabilityVault, collateralVault, source),
  )
}

export const getCollateralUsdValueOrZero = async (
  ...args: Parameters<typeof getCollateralUsdValue>
): Promise<number> => {
  return (await getCollateralUsdValue(...args)) ?? 0
}

export const getTokenUsdPrice = async (
  tokenAddress: string,
): Promise<number | undefined> => {
  const { chainId } = useEulerAddresses()
  const sdk = await getEulerSdk()
  const price = await sdk.priceService.fetchAssetUsdPriceByAddress(
    chainId.value,
    getAddress(tokenAddress as Address),
  )
  return price
}

export const getTokenUsdValue = async (
  amount: bigint,
  decimals: number,
  tokenAddress: string,
  vault: AnyVault | null | undefined,
): Promise<number | undefined> => {
  if (vault) {
    return getAssetUsdValue(amount, vault, 'off-chain')
  }

  const price = await getTokenUsdPrice(tokenAddress)
  if (price === undefined) return undefined
  return nanoToValue(amount, decimals) * price
}

export const formatAssetValue = async (
  amount: number | bigint,
  vault: AnyVault | null | undefined,
  source: PriceSource = 'off-chain',
  _backend?: unknown,
  options: { maxDecimals?: number, minDecimals?: number } = {},
): Promise<{ display: string, hasPrice: boolean, usdValue: number, assetAmount: number, assetSymbol: string }> => {
  const { maxDecimals = 2 } = options

  if (!vault) {
    return {
      display: '-',
      hasPrice: false,
      usdValue: 0,
      assetAmount: 0,
      assetSymbol: '',
    }
  }

  const assetAmount = typeof amount === 'bigint' ? nanoToValue(amount, vault.asset.decimals) : amount
  const price = await getAssetUsdPrice(vault, source)
  const usdValue = tokenAmountToUsdValue(amount, vault.asset.decimals, price)

  if (usdValue === undefined) {
    return {
      display: `${formatSmartAmount(assetAmount, maxDecimals)} ${vault.asset.symbol}`,
      hasPrice: false,
      usdValue: 0,
      assetAmount,
      assetSymbol: vault.asset.symbol,
    }
  }

  return {
    display: '',
    hasPrice: true,
    usdValue,
    assetAmount,
    assetSymbol: vault.asset.symbol,
  }
}

export const conservativePriceRatio = (
  collateralPrice: PriceResult | null | undefined,
  liabilityPrice: PriceResult | null | undefined,
): bigint => {
  if (!collateralPrice || !liabilityPrice) return 0n
  const ask = liabilityPrice.amountOutAsk
  if (!ask) return 0n
  return (collateralPrice.amountOutBid * ONE_18) / ask
}

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

export const calculateLiquidationRatio = (
  collateralOraclePrice: PriceResult | null | undefined,
  liabilityOraclePrice: PriceResult | null | undefined,
): bigint => {
  return conservativePriceRatio(collateralOraclePrice, liabilityOraclePrice)
}
