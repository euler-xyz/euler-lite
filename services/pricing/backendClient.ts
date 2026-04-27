import type { Address } from 'viem'
import { CACHE_TTL_1MIN_MS, BATCH_DELAY_COLLECT_MS } from '~/entities/tuning-constants'
import { logger } from '~/utils/logger'

// -------------------------------------------
// Backend Response Types
// -------------------------------------------

/**
 * Response shape from the price backend (indexer /v1/prices endpoint).
 */
export type BackendPriceData = {
  /** Asset address */
  address: string
  /** Price in USD as number */
  price: number
  /** Price source (e.g., "pyth", "defillama") */
  source: string
  /** Asset symbol */
  symbol: string
  /** Unix timestamp when this price was recorded */
  timestamp: number
}

/**
 * Response from /v1/prices endpoint.
 * Flat object keyed by lowercase address.
 */
export type BackendPriceResponse = Record<string, BackendPriceData>

// -------------------------------------------
// Configuration
// -------------------------------------------

let backendEndpoint: string | undefined
let currentChainId: number | undefined

/**
 * Configure the backend client.
 * Call this when the app initializes or chain changes.
 */
export const configureBackend = (endpoint: string | undefined, chainId?: number) => {
  backendEndpoint = endpoint || undefined
  currentChainId = chainId
}

/**
 * Check if backend is configured and available.
 */
export const isBackendConfigured = (): boolean => {
  return !!backendEndpoint
}

// -------------------------------------------
// Cache
// -------------------------------------------

type CachedPrice = {
  data: BackendPriceData
  fetchedAt: number
}

const priceCache = new Map<string, CachedPrice>()

const getCacheKey = (assetAddress: string, chainId?: number): string => {
  return `${chainId || currentChainId || 1}:${assetAddress.toLowerCase()}`
}

/**
 * Clear stale cache entries.
 */
export const clearStaleBackendCache = () => {
  const now = Date.now()
  for (const [key, cached] of priceCache.entries()) {
    if ((now - cached.fetchedAt) >= CACHE_TTL_1MIN_MS) {
      priceCache.delete(key)
    }
  }
}

/**
 * Clear all cached prices and cancel pending batch requests.
 * Call on chain switch to prevent stale cross-chain data.
 */
export const clearBackendCache = () => {
  priceCache.clear()

  // Cancel pending batch: resolve all with undefined so callers get no data
  // rather than stale cross-chain prices
  if (batchTimeout) {
    clearTimeout(batchTimeout)
    batchTimeout = null
  }
  const pending = pendingRequests
  pendingRequests = []
  for (const req of pending) {
    req.resolve(undefined)
  }
}

// -------------------------------------------
// Request Batching
// -------------------------------------------

type PendingRequest = {
  address: Address
  chainId: number
  resolve: (data: BackendPriceData | undefined) => void
  reject: (err: unknown) => void
}

let pendingRequests: PendingRequest[] = []
let batchTimeout: ReturnType<typeof setTimeout> | null = null

/**
 * Execute all pending requests as a batched call.
 */
const executeBatch = async () => {
  batchTimeout = null
  const requests = pendingRequests
  pendingRequests = []

  if (requests.length === 0) return

  // Group requests by chainId
  const byChain = new Map<number, PendingRequest[]>()
  for (const req of requests) {
    const existing = byChain.get(req.chainId) || []
    existing.push(req)
    byChain.set(req.chainId, existing)
  }

  // Execute batched requests for each chain
  for (const [chainId, chainRequests] of byChain.entries()) {
    const addresses = [...new Set(chainRequests.map(r => r.address))]

    try {
      const results = await fetchBackendPricesBatch(addresses, chainId)

      // Resolve each pending request
      for (const req of chainRequests) {
        const data = results?.get(req.address.toLowerCase())
        req.resolve(data)
      }
    }
    catch (err) {
      for (const req of chainRequests) {
        req.reject(err)
      }
    }
  }
}

// -------------------------------------------
// Fetch Functions
// -------------------------------------------

/**
 * Internal: Execute a batched fetch without debouncing.
 * Used by the batching system.
 */
const fetchBackendPricesBatch = async (
  assetAddresses: Address[],
  chainId?: number,
): Promise<Map<string, BackendPriceData> | undefined> => {
  if (!backendEndpoint || !assetAddresses.length) {
    return undefined
  }

  const effectiveChainId = chainId || currentChainId || 1
  const now = Date.now()
  const results = new Map<string, BackendPriceData>()
  const missingAddresses: Address[] = []

  // Check cache first
  for (const address of assetAddresses) {
    const key = getCacheKey(address, effectiveChainId)
    const cached = priceCache.get(key)
    if (cached && (now - cached.fetchedAt) < CACHE_TTL_1MIN_MS) {
      results.set(address.toLowerCase(), cached.data)
    }
    else {
      missingAddresses.push(address)
    }
  }

  // All found in cache
  if (missingAddresses.length === 0) {
    return results
  }

  try {
    // Build request URL
    const url = new URL('/v1/prices', backendEndpoint)
    url.searchParams.set('chainId', String(effectiveChainId))
    url.searchParams.set('assets', missingAddresses.join(','))

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    })

    if (!response.ok) {
      return results.size > 0 ? results : undefined
    }

    const data: BackendPriceResponse = await response.json()

    // Map response to results and update cache
    // Response is a flat object keyed by address
    for (const [address, priceData] of Object.entries(data)) {
      const normalizedAddr = address.toLowerCase()
      results.set(normalizedAddr, priceData)

      // Update cache
      const key = getCacheKey(address, effectiveChainId)
      priceCache.set(key, {
        data: priceData,
        fetchedAt: now,
      })
    }

    return results
  }
  catch (err) {
    logger.warn({ ctx: 'backendClient/fetchPrices', err }, 'backend price fetch failed')
    // Return cached results if we have any
    return results.size > 0 ? results : undefined
  }
}

/**
 * Fetch asset prices from backend.
 * Returns undefined if backend is not configured or request fails.
 *
 * @param assetAddresses - Array of asset addresses to fetch prices for
 * @param chainId - Optional chain ID (uses configured default if not provided)
 */
export const fetchBackendPrices = async (
  assetAddresses: Address[],
  chainId?: number,
): Promise<Map<string, BackendPriceData> | undefined> => {
  return fetchBackendPricesBatch(assetAddresses, chainId)
}

/**
 * Fetch a single asset price from backend.
 * Requests are automatically batched - multiple calls within 50ms
 * are combined into a single network request.
 */
export const fetchBackendPrice = async (
  assetAddress: Address,
  chainId?: number,
): Promise<BackendPriceData | undefined> => {
  if (!backendEndpoint) {
    return undefined
  }

  const effectiveChainId = chainId || currentChainId || 1

  // Check cache first to avoid adding to batch
  const key = getCacheKey(assetAddress, effectiveChainId)
  const cached = priceCache.get(key)
  if (cached && (Date.now() - cached.fetchedAt) < CACHE_TTL_1MIN_MS) {
    return cached.data
  }

  // Add to pending batch
  return new Promise<BackendPriceData | undefined>((resolve, reject) => {
    pendingRequests.push({
      address: assetAddress,
      chainId: effectiveChainId,
      resolve,
      reject,
    })

    // Schedule batch execution if not already scheduled
    if (!batchTimeout) {
      batchTimeout = setTimeout(executeBatch, BATCH_DELAY_COLLECT_MS)
    }
  })
}

// -------------------------------------------
// Price Conversion Helper
// -------------------------------------------

const _ONE_18 = 10n ** 18n

/**
 * Convert backend price to bigint (18 decimals).
 * Accepts both string (legacy) and number (current API) formats.
 * Use this to convert backend prices to the same format as on-chain prices.
 */
export const backendPriceToBigInt = (price: string | number): bigint => {
  try {
    const priceNum = typeof price === 'number' ? price : parseFloat(price)
    if (isNaN(priceNum) || priceNum < 0) {
      return 0n
    }
    // Use toFixed(18) to avoid scientific notation (e.g., 1e-8 -> "0.00000001")
    // This handles very small prices that would otherwise fail string parsing
    const priceString = priceNum.toFixed(18)
    const [intPart, decPart = ''] = priceString.split('.')
    const paddedDec = decPart.slice(0, 18)
    return BigInt(intPart + paddedDec)
  }
  catch {
    return 0n
  }
}
