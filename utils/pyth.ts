import { type Hex, type Address, encodeFunctionData, zeroAddress, type Abi, decodeFunctionResult } from 'viem'
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { collectPythFeedsFromAdapters } from '@eulerxyz/euler-v2-sdk'
import { PYTH_ABI } from '~/abis/pyth'
import { DEFAULT_PRICE_CACHE_TTL_MS } from '~/entities/constants'
import { CACHE_TTL_15S_MS, BATCH_DELAY_COLLECT_MS } from '~/entities/tuning-constants'
import type { PythFeed } from '~/entities/oracle'
import type { BatchItem } from '~/abis/evc'
import type { EVCCall } from './evc-converter'

import { getPublicClient } from '~/utils/public-client'
import { evcBatchCall } from '~/utils/multicall'
import { logger } from '~/utils/logger'

const normalizeHex = (value: string): Hex => (value.startsWith('0x') ? value as Hex : (`0x${value}` as Hex))
const normalizeFeedId = (value: string): Hex => normalizeHex(value).toLowerCase() as Hex

type CachedPrice = {
  price: bigint
  expiresAt: number
}

const priceCache = new Map<string, CachedPrice>()

// -------------------------------------------
// Pyth Update Data Batching
// -------------------------------------------

type PythPendingRequest = {
  feedIds: Hex[]
  endpoint: string
  resolve: (data: Hex[]) => void
  reject: (err: unknown) => void
}

type CachedPythUpdate = {
  data: Hex[]
  fetchedAt: number
}

let pythPendingRequests: PythPendingRequest[] = []
let pythBatchTimeout: ReturnType<typeof setTimeout> | null = null
const pythUpdateCache = new Map<string, CachedPythUpdate>()

const getPythCacheKey = (feedIds: Hex[], endpoint: string): string => {
  const sortedIds = [...feedIds].sort().join(',')
  return `${endpoint}:${sortedIds}`
}

/**
 * Execute all pending Pyth update requests as batched calls.
 */
const executePythBatch = async () => {
  pythBatchTimeout = null
  const requests = pythPendingRequests
  pythPendingRequests = []

  if (requests.length === 0) return

  // Group requests by endpoint
  const byEndpoint = new Map<string, PythPendingRequest[]>()
  for (const req of requests) {
    const existing = byEndpoint.get(req.endpoint) || []
    existing.push(req)
    byEndpoint.set(req.endpoint, existing)
  }

  // Execute batched requests for each endpoint
  for (const [endpoint, endpointRequests] of byEndpoint.entries()) {
    // Collect all unique feed IDs for this endpoint
    const allFeedIds = new Set<Hex>()
    for (const req of endpointRequests) {
      req.feedIds.forEach(id => allFeedIds.add(normalizeFeedId(id)))
    }

    const feedIdArray = [...allFeedIds]
    const cacheKey = getPythCacheKey(feedIdArray, endpoint)
    const now = Date.now()

    // Check cache first
    const cached = pythUpdateCache.get(cacheKey)
    if (cached && (now - cached.fetchedAt) < CACHE_TTL_15S_MS) {
      for (const req of endpointRequests) {
        req.resolve(cached.data)
      }
      continue
    }

    try {
      const data = await fetchPythUpdateDataDirect(feedIdArray, endpoint)

      // Cache the result with current timestamp (after async operation completes)
      pythUpdateCache.set(cacheKey, {
        data,
        fetchedAt: Date.now(),
      })

      // Resolve all requests for this endpoint
      for (const req of endpointRequests) {
        req.resolve(data)
      }
    }
    catch (err) {
      for (const req of endpointRequests) {
        req.reject(err)
      }
    }
  }
}

/**
 * Direct fetch without batching - used internally by the batching system.
 * Routes through server proxy at /api/pyth/updates to avoid CORS and credential exposure.
 */
const fetchPythUpdateDataDirect = async (feedIds: Hex[], _endpoint: string): Promise<Hex[]> => {
  if (!feedIds.length) {
    return []
  }

  try {
    const url = new URL('/api/pyth/updates', window.location.origin)
    feedIds.forEach(id => url.searchParams.append('ids[]', id))
    url.searchParams.set('encoding', 'hex')

    const response = await fetch(url.toString())
    if (!response.ok) {
      throw new Error(`Failed to fetch Pyth data: ${response.status}`)
    }

    const body = await response.json()
    const binaryData = body?.binary?.data || []
    if (!Array.isArray(binaryData)) {
      return []
    }

    return binaryData.map((item: string) => normalizeHex(item))
  }
  catch (err) {
    logger.warn({ ctx: 'pyth/fetchPythUpdateDataDirect', err }, 'failed to fetch Pyth update data')
    return []
  }
}

const priceToAmountOutMid = (price: { price: string, expo: number }): bigint => {
  const raw = BigInt(price.price)
  const scale = price.expo + 18
  if (scale >= 0) {
    return raw * (10n ** BigInt(scale))
  }
  return raw / (10n ** BigInt(-scale))
}

const collectFeedsFromVault = (vault: EVault | undefined, _maxDepth: number): PythFeed[] => {
  if (!vault) return []

  const feeds = collectPythFeedsFromAdapters(vault.oracle.adapters)

  const unique = new Map<string, PythFeed>()
  feeds.forEach((feed) => {
    const key = `${feed.pythAddress.toLowerCase()}:${feed.feedId.toLowerCase()}`
    if (!unique.has(key)) {
      unique.set(key, feed)
    }
  })

  return [...unique.values()]
}

export const collectPythFeedsFromVaults = (
  vaults: (EVault | undefined)[],
  maxDepth = 3,
): PythFeed[] => {
  const merged = vaults.flatMap(vault => collectFeedsFromVault(vault, maxDepth))
  const unique = new Map<string, PythFeed>()

  merged.forEach((feed) => {
    const key = `${feed.pythAddress.toLowerCase()}:${feed.feedId.toLowerCase()}`
    if (!unique.has(key)) {
      unique.set(key, feed)
    }
  })

  return [...unique.values()]
}

/**
 * Collect Pyth feeds needed for a health check: only feeds from the LIABILITY vault's
 * oracle chain that are used to price the enabled collaterals and the liability itself.
 */
export const collectPythFeedsForHealthCheck = (
  liabilityVault: EVault,
  collateralVaultAddresses: string[],
): PythFeed[] => {
  const allFeeds: PythFeed[] = []

  // Feeds for liability asset pricing
  allFeeds.push(...collectPythFeedsFromAdapters(liabilityVault.debtPricingOracleAdapters))

  // Feeds for each collateral vault pricing
  for (const collateralVaultAddress of collateralVaultAddresses) {
    const feeds = collectPythFeedsFromAdapters(
      liabilityVault.collaterals.find(collateral =>
        collateral.address.toLowerCase() === collateralVaultAddress.toLowerCase(),
      )?.oracleAdapters ?? [],
    )
    allFeeds.push(...feeds)
  }

  // Deduplicate
  const unique = new Map<string, PythFeed>()
  allFeeds.forEach((feed) => {
    const key = `${feed.pythAddress.toLowerCase()}:${feed.feedId.toLowerCase()}`
    if (!unique.has(key)) {
      unique.set(key, feed)
    }
  })

  return [...unique.values()]
}

/**
 * Fetch Pyth update data with automatic request batching.
 * Multiple calls within 50ms are combined into a single network request.
 */
export const fetchPythUpdateData = async (feedIds: Hex[], endpoint?: string): Promise<Hex[]> => {
  if (!feedIds.length || !endpoint) {
    return []
  }

  const normalizedIds = feedIds.map(id => normalizeFeedId(id))
  const cacheKey = getPythCacheKey(normalizedIds, endpoint)
  const now = Date.now()

  // Check cache first to avoid adding to batch
  const cached = pythUpdateCache.get(cacheKey)
  if (cached && (now - cached.fetchedAt) < CACHE_TTL_15S_MS) {
    return cached.data
  }

  // Add to pending batch
  return new Promise<Hex[]>((resolve, reject) => {
    pythPendingRequests.push({
      feedIds: normalizedIds,
      endpoint,
      resolve,
      reject,
    })

    // Schedule batch execution if not already scheduled
    if (!pythBatchTimeout) {
      pythBatchTimeout = setTimeout(executePythBatch, BATCH_DELAY_COLLECT_MS)
    }
  })
}

export const buildPythUpdateCallsFromFeeds = async (
  feeds: PythFeed[],
  providerUrl: string,
  hermesEndpoint: string | undefined,
  sender: Address,
): Promise<{ calls: EVCCall[], totalFee: bigint }> => {
  if (!feeds.length || !hermesEndpoint) {
    return { calls: [], totalFee: 0n }
  }

  const grouped = new Map<string, { pythAddress: Address, feedIds: Set<Hex> }>()
  feeds.forEach((feed) => {
    const key = feed.pythAddress.toLowerCase()
    if (!grouped.has(key)) {
      grouped.set(key, { pythAddress: feed.pythAddress, feedIds: new Set() })
    }
    grouped.get(key)?.feedIds.add(feed.feedId)
  })

  const client = getPublicClient(providerUrl)
  const calls: EVCCall[] = []
  let totalFee = 0n

  for (const [, { pythAddress, feedIds: feedSet }] of grouped.entries()) {
    const updateData = await fetchPythUpdateData([...feedSet], hermesEndpoint)
    if (!updateData.length) continue

    let fee = 0n
    try {
      fee = await client.readContract({
        address: pythAddress,
        abi: PYTH_ABI,
        functionName: 'getUpdateFee',
        args: [updateData],
      }) as bigint
    }
    catch (err) {
      logger.warn({ ctx: 'pyth/buildPythUpdateCalls', err }, 'getUpdateFee failed')
      continue
    }

    calls.push({
      targetContract: pythAddress,
      onBehalfOfAccount: sender,
      value: fee,
      data: encodeFunctionData({
        abi: PYTH_ABI,
        functionName: 'updatePriceFeeds',
        args: [updateData],
      }) as Hex,
    })

    totalFee += fee
  }

  return { calls, totalFee }
}

export const buildPythUpdateCalls = async (
  vaults: (EVault | undefined)[],
  providerUrl: string,
  hermesEndpoint: string | undefined,
  sender: Address,
): Promise<{ calls: EVCCall[], totalFee: bigint }> => {
  const feeds = collectPythFeedsFromVaults(vaults)
  return buildPythUpdateCallsFromFeeds(feeds, providerUrl, hermesEndpoint, sender)
}

export const fetchPythPrices = async (
  feedIds: Hex[],
  hermesEndpoint?: string,
  cacheTtlMs = DEFAULT_PRICE_CACHE_TTL_MS,
): Promise<Map<string, bigint>> => {
  const prices = new Map<string, bigint>()
  if (!feedIds.length || !hermesEndpoint) {
    return prices
  }

  const now = Date.now()
  const missing: Hex[] = []

  feedIds.forEach((feedId) => {
    const key = normalizeFeedId(feedId)
    const cached = priceCache.get(key)
    if (cached && cached.expiresAt > now) {
      prices.set(key, cached.price)
      return
    }
    missing.push(key)
  })

  if (!missing.length) {
    return prices
  }

  try {
    const url = new URL('/api/pyth/updates', window.location.origin)
    missing.forEach(id => url.searchParams.append('ids[]', id))
    url.searchParams.set('encoding', 'hex')
    url.searchParams.set('parsed', 'true')

    const response = await fetch(url.toString())
    if (!response.ok) {
      throw new Error(`Pyth prices proxy returned ${response.status}`)
    }

    const body = await response.json()
    const parsed: Array<{ id: string, price: { price: string, expo: number } }> = body?.parsed || []

    parsed.forEach((feed) => {
      const key = normalizeFeedId(feed.id)
      const amountOutMid = priceToAmountOutMid(feed.price)
      priceCache.set(key, {
        price: amountOutMid,
        expiresAt: now + cacheTtlMs,
      })
      prices.set(key, amountOutMid)
    })
  }
  catch (err) {
    logger.warn({ ctx: 'pyth/fetchPythPrices', err }, 'failed to fetch Pyth prices')
  }

  return prices
}

export const sumCallValues = (calls: EVCCall[]): bigint => calls.reduce((acc, call) => acc + (call.value || 0n), 0n)

/**
 * Build batch items for Pyth updates.
 * Reusable for both vault fetching AND account lens fetching via batchSimulation.
 *
 * @param vaults - Array of vaults to collect Pyth feeds from
 * @param providerUrl - JSON-RPC provider URL
 * @param hermesEndpoint - Pyth Hermes endpoint URL
 * @returns BatchItem array for Pyth updates and total fee required
 */
export const buildPythBatchItems = async (
  vaults: (EVault | undefined)[],
  providerUrl: string,
  hermesEndpoint: string | undefined,
): Promise<{ items: BatchItem[], totalFee: bigint }> => {
  const feeds = collectPythFeedsFromVaults(vaults)
  if (!feeds.length || !hermesEndpoint) {
    return { items: [], totalFee: 0n }
  }

  const grouped = new Map<Address, Set<Hex>>()
  feeds.forEach((feed) => {
    const key = feed.pythAddress
    if (!grouped.has(key)) {
      grouped.set(key, new Set())
    }
    grouped.get(key)?.add(feed.feedId)
  })

  const client = getPublicClient(providerUrl)
  const items: BatchItem[] = []
  let totalFee = 0n

  for (const [pythAddress, feedSet] of grouped.entries()) {
    const updateData = await fetchPythUpdateData([...feedSet], hermesEndpoint)
    if (!updateData.length) continue

    let fee = 0n
    try {
      fee = await client.readContract({
        address: pythAddress,
        abi: PYTH_ABI,
        functionName: 'getUpdateFee',
        args: [updateData],
      }) as bigint
    }
    catch (err) {
      logger.warn({ ctx: 'pyth/buildPythBatchItems', err }, 'getUpdateFee failed')
      continue
    }

    items.push({
      targetContract: pythAddress,
      onBehalfOfAccount: zeroAddress,
      value: fee,
      data: encodeFunctionData({
        abi: PYTH_ABI,
        functionName: 'updatePriceFeeds',
        args: [updateData],
      }),
    })
    totalFee += fee
  }

  return { items, totalFee }
}

/**
 * Build batch items from pre-collected Pyth feeds.
 * Use when you've already collected feeds from multiple sources (e.g., liability + all collaterals).
 *
 * @param feeds - Array of PythFeed objects
 * @param providerUrl - JSON-RPC provider URL
 * @param hermesEndpoint - Pyth Hermes endpoint URL
 * @returns BatchItem array for Pyth updates and total fee required
 */
export const buildPythBatchItemsFromFeeds = async (
  feeds: PythFeed[],
  providerUrl: string,
  hermesEndpoint: string | undefined,
): Promise<{ items: BatchItem[], totalFee: bigint }> => {
  if (!feeds.length || !hermesEndpoint) {
    return { items: [], totalFee: 0n }
  }

  const grouped = new Map<Address, Set<Hex>>()
  feeds.forEach((feed) => {
    const key = feed.pythAddress
    if (!grouped.has(key)) {
      grouped.set(key, new Set())
    }
    grouped.get(key)?.add(feed.feedId)
  })

  const client = getPublicClient(providerUrl)
  const items: BatchItem[] = []
  let totalFee = 0n

  for (const [pythAddress, feedSet] of grouped.entries()) {
    const updateData = await fetchPythUpdateData([...feedSet], hermesEndpoint)
    if (!updateData.length) continue

    let fee = 0n
    try {
      fee = await client.readContract({
        address: pythAddress,
        abi: PYTH_ABI,
        functionName: 'getUpdateFee',
        args: [updateData],
      }) as bigint
    }
    catch (err) {
      logger.warn({ ctx: 'pyth/buildPythBatchItemsFromFeeds', err }, 'getUpdateFee failed')
      continue
    }

    items.push({
      targetContract: pythAddress,
      onBehalfOfAccount: zeroAddress,
      value: fee,
      data: encodeFunctionData({
        abi: PYTH_ABI,
        functionName: 'updatePriceFeeds',
        args: [updateData],
      }),
    })
    totalFee += fee
  }

  return { items, totalFee }
}

/**
 * Execute a lens call with Pyth simulation.
 * Generic helper that handles the common pattern of:
 * 1. Building Pyth update batch items
 * 2. Building the lens call batch item
 * 3. Executing batchSimulation
 * 4. Returning the decoded lens result
 *
 * @param feeds - Pyth feeds to update
 * @param lensAddress - Address of the lens contract
 * @param lensAbi - ABI of the lens contract
 * @param lensMethod - Method name to call on the lens
 * @param lensArgs - Arguments for the lens method
 * @param evcAddress - EVC contract address
 * @param providerUrl - Provider URL for Pyth batch building and RPC calls
 * @param hermesEndpoint - Pyth Hermes endpoint
 * @returns Decoded lens result, or undefined if simulation fails
 */
export const executeLensWithPythSimulation = async <T>(
  feeds: PythFeed[],
  lensAddress: Address,
  lensAbi: Abi | readonly unknown[],
  lensMethod: string,
  lensArgs: unknown[],
  evcAddress: string,
  providerUrl: string,
  hermesEndpoint: string,
): Promise<T | undefined> => {
  try {
    const { items: pythItems } = await buildPythBatchItemsFromFeeds(
      feeds,
      providerUrl,
      hermesEndpoint,
    )

    const lensBatchItem: BatchItem = {
      targetContract: lensAddress as `0x${string}`,
      onBehalfOfAccount: zeroAddress,
      value: 0n,
      data: encodeFunctionData({
        abi: lensAbi as Abi,
        functionName: lensMethod,
        args: lensArgs,
      }) as `0x${string}`,
    }

    const batchItems = [...pythItems, lensBatchItem]

    const batchResults = await evcBatchCall(evcAddress, batchItems, providerUrl)

    const lensResult = batchResults[batchResults.length - 1]
    if (!lensResult?.success) {
      return undefined
    }

    return decodeFunctionResult({
      abi: lensAbi as Abi,
      functionName: lensMethod,
      data: lensResult.result as Hex,
    }) as T
  }
  catch (err) {
    logger.warn({ ctx: 'pyth/executeLensWithPythSimulation', err }, 'lens-with-Pyth simulation failed')
    return undefined
  }
}

/**
 * Execute lens calls for multiple entries in a single batchSimulation with Pyth updates.
 * Combines all Pyth feed updates + all lens calls into one RPC request.
 *
 * @param entries - Array of { key, feeds, args } for each lens call
 * @param lensAddress - Address of the lens contract
 * @param lensAbi - ABI of the lens contract
 * @param lensMethod - Method name to call on the lens (e.g. 'getVaultInfoFull')
 * @param evcAddress - EVC contract address
 * @param providerUrl - Provider URL for Pyth batch building and RPC calls
 * @param hermesEndpoint - Pyth Hermes endpoint
 * @param batchSize - Max lens calls per batchSimulation (default 25)
 * @returns Map of key → decoded result (undefined for failed entries)
 */
export const executeBatchLensWithPythSimulation = async <T>(
  entries: Array<{ key: string, feeds: PythFeed[], args: unknown[] }>,
  lensAddress: Address,
  lensAbi: Abi | readonly unknown[],
  lensMethod: string,
  evcAddress: string,
  providerUrl: string,
  hermesEndpoint: string,
  batchSize = 25,
): Promise<Map<string, T | undefined>> => {
  const results = new Map<string, T | undefined>()

  if (entries.length === 0) {
    return results
  }

  try {
    // Merge and deduplicate all Pyth feeds across all entries
    const uniqueFeeds = new Map<string, PythFeed>()
    for (const entry of entries) {
      for (const feed of entry.feeds) {
        const feedKey = `${feed.pythAddress.toLowerCase()}:${feed.feedId.toLowerCase()}`
        if (!uniqueFeeds.has(feedKey)) {
          uniqueFeeds.set(feedKey, feed)
        }
      }
    }

    // Build Pyth update items once (shared across all sub-batches)
    const { items: pythItems } = await buildPythBatchItemsFromFeeds(
      [...uniqueFeeds.values()],
      providerUrl,
      hermesEndpoint,
    )

    // Build lens items for each entry
    const lensEntries = entries.map(entry => ({
      key: entry.key,
      item: {
        targetContract: lensAddress as `0x${string}`,
        onBehalfOfAccount: zeroAddress,
        value: 0n,
        data: encodeFunctionData({
          abi: lensAbi as Abi,
          functionName: lensMethod,
          args: entry.args,
        }) as `0x${string}`,
      } satisfies BatchItem,
    }))

    // Split lens items into sub-batches, each prepended with full Pyth updates
    const chunks: typeof lensEntries[] = []
    for (let i = 0; i < lensEntries.length; i += batchSize) {
      chunks.push(lensEntries.slice(i, i + batchSize))
    }

    const chunkResults = await Promise.all(
      chunks.map(async (chunk) => {
        const batchItems = [...pythItems, ...chunk.map(c => c.item)]

        const batchResults = await evcBatchCall(evcAddress, batchItems, providerUrl)

        return chunk.map((entry, i) => {
          const lensResult = batchResults[pythItems.length + i]
          if (!lensResult?.success) {
            return { key: entry.key, result: undefined as T | undefined }
          }

          try {
            const decoded = decodeFunctionResult({
              abi: lensAbi as Abi,
              functionName: lensMethod,
              data: lensResult.result as Hex,
            })
            return { key: entry.key, result: decoded as T }
          }
          catch {
            return { key: entry.key, result: undefined as T | undefined }
          }
        })
      }),
    )

    for (const chunk of chunkResults) {
      for (const entry of chunk) {
        results.set(entry.key, entry.result)
      }
    }
  }
  catch (err) {
    logger.warn({ ctx: 'pyth/executeBatchLensWithPythSimulation', err }, 'batch lens-with-Pyth simulation failed')
  }

  return results
}

export const pythAbi = PYTH_ABI
