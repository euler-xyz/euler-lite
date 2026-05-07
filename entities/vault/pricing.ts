import type { Address } from 'viem'
import { USD_ADDRESS } from '~/entities/constants'
import { eulerUtilsLensABI } from '~/entities/euler/abis'
import { logger } from '~/utils/logger'
import { getPublicClient } from '~/utils/public-client'
import { summarizeViemError } from '~/utils/viem-errors'

export interface FullAssetPriceInfo {
  amountIn: bigint
  amountOutAsk: bigint
  amountOutBid: bigint
  amountOutMid: bigint
  timestamp: bigint
  oracle: string
}

const unitOfAccountPriceCache = new Map<string, { amountOutMid: bigint } | null>()
const assetPriceCache = new Map<string, FullAssetPriceInfo | null>()
const pendingAssetResolutions = new Map<string, Promise<FullAssetPriceInfo | undefined>>()

let cacheGeneration = 0

const ONE_18 = 10n ** 18n

const fetchAssetPrice = async (
  rpcUrl: string,
  utilsLensAddress: string,
  assetAddress: string,
): Promise<FullAssetPriceInfo | undefined> => {
  const client = getPublicClient(rpcUrl)
  const priceInfo = await client.readContract({
    address: utilsLensAddress as Address,
    abi: eulerUtilsLensABI,
    functionName: 'getAssetPriceInfo',
    args: [assetAddress as Address, USD_ADDRESS],
  }) as Record<string, unknown>

  // Note: 0n is a valid price (very small value), only reject null/undefined or explicit failure
  if (priceInfo.queryFailure || priceInfo.amountOutMid === undefined || priceInfo.amountOutMid === null) {
    return undefined
  }

  return {
    amountIn: priceInfo.amountIn as bigint,
    amountOutAsk: priceInfo.amountOutAsk as bigint,
    amountOutBid: priceInfo.amountOutBid as bigint,
    amountOutMid: priceInfo.amountOutMid as bigint,
    timestamp: priceInfo.timestamp as bigint,
    oracle: priceInfo.oracle as string,
  }
}

/**
 * Resolve asset price with caching and concurrent request deduplication.
 * Multiple callers requesting the same asset price simultaneously will share a single RPC call.
 */
const resolveAndCacheAssetPrice = (
  rpcUrl: string,
  utilsLensAddress: string,
  assetAddress: string,
): Promise<FullAssetPriceInfo | undefined> => {
  const key = assetAddress.toLowerCase()

  // Check cache
  const cached = assetPriceCache.get(key)
  if (cached !== undefined) {
    return Promise.resolve(cached || undefined)
  }

  // Concurrent dedup: reuse in-flight request
  const pending = pendingAssetResolutions.get(key)
  if (pending) {
    return pending
  }

  const gen = cacheGeneration
  const promise = fetchAssetPrice(rpcUrl, utilsLensAddress, assetAddress)
    .then((result) => {
      // Only populate cache if no chain switch occurred during fetch
      if (cacheGeneration === gen) {
        assetPriceCache.set(key, result ?? null)
      }
      return result
    })
    .catch((e) => {
      logger.warn(
        { ctx: 'pricing/resolveAssetPrice', asset: assetAddress, err: e },
        `error fetching price for asset ${assetAddress}`,
      )
      // Negatively cache only contract-level failures. Transport errors
      // (RPC down, rate limit, timeout) are transient — caching null here
      // would poison this asset's price for the rest of the process lifetime,
      // since clearPriceCaches() only fires on chain switch.
      if (cacheGeneration === gen && !summarizeViemError(e).isTransport) {
        assetPriceCache.set(key, null)
      }
      return undefined
    })
    .finally(() => {
      pendingAssetResolutions.delete(key)
    })

  pendingAssetResolutions.set(key, promise)
  return promise
}

/**
 * Resolve asset-to-USD price, returning only { amountOutMid }.
 * Results are cached per asset address with concurrent request deduplication.
 */
export const resolveAssetPriceInfo = async (
  rpcUrl: string,
  utilsLensAddress: string,
  assetAddress: string,
): Promise<{ amountOutMid: bigint } | undefined> => {
  const result = await resolveAndCacheAssetPrice(rpcUrl, utilsLensAddress, assetAddress)
  return result ? { amountOutMid: result.amountOutMid } : undefined
}

/**
 * Resolve full asset price info including all fields (amountIn, ask/bid/mid, timestamp, oracle).
 * Shares the same cache and dedup as resolveAssetPriceInfo — no additional RPC call.
 */
export const resolveFullAssetPriceInfo = async (
  rpcUrl: string,
  utilsLensAddress: string,
  assetAddress: string,
): Promise<FullAssetPriceInfo | undefined> => {
  return resolveAndCacheAssetPrice(rpcUrl, utilsLensAddress, assetAddress)
}

export const resolveUnitOfAccountPriceInfo = async (
  rpcUrl: string,
  utilsLensAddress: string,
  unitOfAccount?: string,
): Promise<{ amountOutMid: bigint } | undefined> => {
  if (!unitOfAccount) {
    return undefined
  }
  const normalized = unitOfAccount.toLowerCase()

  if (normalized === USD_ADDRESS.toLowerCase()) {
    return { amountOutMid: ONE_18 }
  }

  // Check cache
  const cached = unitOfAccountPriceCache.get(normalized)
  if (cached) {
    return cached
  }
  if (cached === null) {
    return undefined
  }

  const priceInfo = await resolveAssetPriceInfo(rpcUrl, utilsLensAddress, unitOfAccount)
  if (priceInfo || assetPriceCache.has(normalized)) {
    unitOfAccountPriceCache.set(normalized, priceInfo || null)
  }
  return priceInfo
}

/**
 * Clear all price caches. Call on chain switch to prevent stale cross-chain data.
 */
export const clearPriceCaches = (): void => {
  cacheGeneration++
  assetPriceCache.clear()
  unitOfAccountPriceCache.clear()
  pendingAssetResolutions.clear()
}
