import type { Address } from 'viem'
import { CACHE_TTL_1MIN_MS, BATCH_DELAY_COLLECT_MS } from '~/entities/tuning-constants'
import { logWarn } from '~/utils/errorHandling'

// -------------------------------------------
// Backend Response Types
// -------------------------------------------

/**
 * Price entry from the v3 /prices endpoint.
 */
export type BackendPriceData = {
  chainId: number
  address: string
  symbol: string
  priceUsd: number
  source: string
  timestamp: string // ISO-8601
}

/** Max addresses per v3 /prices request. */
const V3_MAX_ADDRESSES = 100

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
  inFlight.clear()

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
 * In-flight fetch promises keyed by `chainId:address` (lowercase).
 * Prevents duplicate network requests for addresses already being fetched.
 */
const inFlight = new Map<string, Promise<BackendPriceData | undefined>>()

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
    // Split: piggyback on in-flight vs need new fetch
    const needFetch: PendingRequest[] = []
    for (const req of chainRequests) {
      const flightKey = getCacheKey(req.address, chainId)
      const existing = inFlight.get(flightKey)
      if (existing) {
        existing.then(data => req.resolve(data), err => req.reject(err))
      }
      else {
        needFetch.push(req)
      }
    }

    if (needFetch.length === 0) continue

    const addresses = [...new Set(needFetch.map(r => r.address))]

    // Register in-flight promises so later batches piggyback
    const fetchPromise = fetchBackendPricesBatch(addresses, chainId)
    for (const addr of addresses) {
      const flightKey = getCacheKey(addr, chainId)
      const addrPromise = fetchPromise.then(results => results?.get(addr.toLowerCase()))
      inFlight.set(flightKey, addrPromise)
      addrPromise.finally(() => inFlight.delete(flightKey))
    }

    try {
      const results = await fetchPromise

      for (const req of needFetch) {
        const data = results?.get(req.address.toLowerCase())
        req.resolve(data)
      }
    }
    catch (err) {
      for (const req of needFetch) {
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
    // v3 API caps at 100 addresses per request — chunk and fetch in parallel
    const chunks: Address[][] = []
    for (let i = 0; i < missingAddresses.length; i += V3_MAX_ADDRESSES) {
      chunks.push(missingAddresses.slice(i, i + V3_MAX_ADDRESSES))
    }

    const fetchChunk = async (chunk: Address[]) => {
      const url = new URL('/v3/prices', backendEndpoint)
      url.searchParams.set('chainId', String(effectiveChainId))
      url.searchParams.set('addresses', chunk.join(','))

      const response = await fetch(url.toString(), {
        method: 'GET',
        headers: { Accept: 'application/json' },
      })

      if (!response.ok) return

      const body = await response.json()
      const prices: BackendPriceData[] = body.data || []

      for (const priceData of prices) {
        const normalizedAddr = priceData.address.toLowerCase()
        results.set(normalizedAddr, priceData)

        const key = getCacheKey(priceData.address, effectiveChainId)
        priceCache.set(key, { data: priceData, fetchedAt: now })
      }
    }

    await Promise.allSettled(chunks.map(fetchChunk))

    return results.size > 0 ? results : undefined
  }
  catch (err) {
    logWarn('backendClient/fetchPrices', err)
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
 * Convert a USD price to bigint (18 decimals).
 * Accepts both string and number formats.
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
