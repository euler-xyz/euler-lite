/**
 * Shared TTL cache + in-flight dedup for public reward-campaign fetches.
 *
 * Handlers in server/api/rewards/* and the warm-cache plugin both call
 * into the refresh* functions below. They share a single map of cache
 * entries (per-provider + per-chain keys) and a single in-flight dedup
 * map, so a warm cycle and a concurrent cold HTTP request collapse onto
 * one upstream round-trip.
 *
 * Raw pass-through: the payloads stored in the cache are the upstream
 * JSON bodies, unmodified. The client composables retain every bit of
 * transform logic (subType mapping, RewardCampaign shape, Brevis
 * snake_case/camelCase normalisation). Server-side changes to provider
 * feature logic would force redeploys; keeping transforms client-side
 * means we only ship a new frontend bundle.
 *
 * Refresh cadence + TTL: the TTL is a safety floor if warm-cache stalls.
 * The 4-min warm cycle (plugin-side) keeps entries well inside the
 * 5-min TTL under normal operation.
 */
import { createTtlCache } from './cache'
import { fetchWithTimeout, withWallClock } from './fetchWithTimeout'
import { logWarn } from './log'
import { getVaultCategories } from './vault-categories-store'
import {
  BREVIS_API_URL,
  FUUL_API_BASE_URL,
  MERKL_API_BASE_URL,
} from '~/entities/constants'

const CACHE_TTL_MS = 5 * 60_000
/** Wall-clock budget for a full paginated Merkl request (all pages combined). */
const MERKL_PAGINATION_BUDGET_MS = 15_000
const MERKL_PAGE_SIZE = 100
// Today each chain has well under 100 opportunities per type; 10 pages gives
// roughly 10x headroom before the cap starts truncating. A partial response
// is never cached — the cap is an upper bound on the warm-cycle time, not a
// silent truncation.
const MAX_MERKL_PAGES = 10

export type MerklOpportunityType = 'EULER' | 'MULTILENDBORROW' | 'ERC20LOGPROCESSOR'
export type FuulProtocol = 'euler' | 'euler-looping'

// Upstream response is unknown — server never interprets shape.
const rewardsCache = createTtlCache<unknown>({ ttlMs: CACHE_TTL_MS, maxEntries: 500 })

// Key → in-flight refresh promise. Concurrent callers share the same
// promise; the .finally() below drops the key once the promise settles.
const inFlight = new Map<string, Promise<unknown>>()

const fetchDeduped = <T>(key: string, task: () => Promise<T>): Promise<T> => {
  const existing = inFlight.get(key) as Promise<T> | undefined
  if (existing) return existing
  const p = task().finally(() => {
    inFlight.delete(key)
  })
  inFlight.set(key, p)
  return p
}

// --- Merkl -----------------------------------------------------------------

const merklTypeKey = (chainId: number, type: MerklOpportunityType): string =>
  `merkl:${type.toLowerCase()}:${chainId}`

/**
 * Loads the earn-vault address set from the chain's vault categorization.
 * Reads the factories-subgraph-derived set (not labels), so unlabeled earn
 * vaults are included — this means direct navigation to an unlabeled earn
 * vault shows its Merkl ERC20LOGPROCESSOR campaigns instead of silently
 * dropping them. Filtering on the server keeps the client payload small.
 */
const getEarnVaultSet = async (chainId: number): Promise<Set<string>> => {
  try {
    const categories = await getVaultCategories(chainId)
    return new Set(categories.earn.map(a => a.toLowerCase()))
  }
  catch (err) {
    logWarn('rewards-cache', `earn vault categorization failed chain=${chainId}:`, err instanceof Error ? err.message : err)
    return new Set()
  }
}

const filterErc20LogProcessor = (
  opportunities: unknown[],
  earnVaults: Set<string>,
): unknown[] => {
  if (earnVaults.size === 0) return []
  return opportunities.filter((op) => {
    if (!op || typeof op !== 'object') return false
    const identifier = (op as Record<string, unknown>).identifier
    return typeof identifier === 'string' && earnVaults.has(identifier.toLowerCase())
  })
}

const fetchMerklType = async (chainId: number, type: MerklOpportunityType): Promise<unknown[]> => {
  // Production Merkl URL — no `&test=true` debug flag.
  const baseUrl = `${MERKL_API_BASE_URL}/opportunities/?chainId=${chainId}&type=${type}&campaigns=true`
  const collected: unknown[] = []

  for (let page = 0; page < MAX_MERKL_PAGES; page++) {
    const url = `${baseUrl}&items=${MERKL_PAGE_SIZE}&page=${page}`
    const resp = await fetchWithTimeout(url)
    if (!resp.ok) {
      throw new Error(`Merkl ${type} returned ${resp.status}`)
    }
    const body = await resp.json() as unknown
    const results = Array.isArray(body) ? body : []
    collected.push(...results)
    if (results.length < MERKL_PAGE_SIZE) {
      // ERC20LOGPROCESSOR returns campaigns for every protocol on the chain;
      // filter against the Euler earn-vault label set before caching so
      // clients don't receive hundreds of irrelevant entries.
      if (type === 'ERC20LOGPROCESSOR') {
        const earnVaults = await getEarnVaultSet(chainId)
        return filterErc20LogProcessor(collected, earnVaults)
      }
      return collected
    }
  }

  // Still more data after MAX_MERKL_PAGES — throw so the caller treats this
  // as a cold-path failure and does NOT cache a truncated dataset.
  throw new Error(`Merkl ${type} chain=${chainId} exceeded ${MAX_MERKL_PAGES}-page cap`)
}

export const refreshMerklType = async (chainId: number, type: MerklOpportunityType): Promise<unknown[]> => {
  const key = merklTypeKey(chainId, type)
  return fetchDeduped(key, async () => {
    const data = await withWallClock(() => fetchMerklType(chainId, type), MERKL_PAGINATION_BUDGET_MS, `merkl/${type} chain=${chainId}`)
    rewardsCache.set(key, data)
    return data
  })
}

// --- Brevis ----------------------------------------------------------------

const brevisKey = (chainId: number): string => `brevis:${chainId}`

export const refreshBrevisCampaigns = async (chainId: number): Promise<unknown> => {
  const key = brevisKey(chainId)
  return fetchDeduped(key, async () => {
    // Body is hardcoded to preserve cache-key simplicity: exposing action or
    // status as a query param would fragment the cache across client-chosen
    // permutations and collapse the warm hit ratio. 2001 = LEND, 2002 = BORROW,
    // 3 = active campaigns — the exact subset useBrevis queries today.
    const body = {
      chain_id: [chainId],
      action: [2001, 2002],
      status: [3],
    }
    const resp = await fetchWithTimeout(BREVIS_API_URL, undefined, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
    })
    if (!resp.ok) {
      throw new Error(`Brevis returned ${resp.status}`)
    }
    const data = await resp.json() as unknown
    rewardsCache.set(key, data)
    return data
  })
}

// --- Fuul ------------------------------------------------------------------

const fuulKey = (chainId: number, protocol: FuulProtocol): string =>
  `fuul:${protocol}:${chainId}`

export const refreshFuulProtocol = async (chainId: number, protocol: FuulProtocol): Promise<unknown> => {
  const key = fuulKey(chainId, protocol)
  return fetchDeduped(key, async () => {
    const url = `${FUUL_API_BASE_URL}/incentives?protocol=${protocol}&chain_id=${chainId}`
    const resp = await fetchWithTimeout(url)
    if (!resp.ok) {
      throw new Error(`Fuul ${protocol} returned ${resp.status}`)
    }
    const data = await resp.json() as unknown
    rewardsCache.set(key, data)
    return data
  })
}

// --- Read helpers ----------------------------------------------------------

export interface CachedEntry<T> {
  data: T
  isStale: boolean
}

const readEntry = <T>(key: string): CachedEntry<T> | undefined => {
  const fresh = rewardsCache.get(key) as T | undefined
  if (fresh !== undefined) return { data: fresh, isStale: false }
  const stale = rewardsCache.getStale(key) as T | undefined
  if (stale !== undefined) return { data: stale, isStale: true }
  return undefined
}

export const readMerklType = (chainId: number, type: MerklOpportunityType): CachedEntry<unknown[]> | undefined =>
  readEntry<unknown[]>(merklTypeKey(chainId, type))

export const readBrevis = (chainId: number): CachedEntry<unknown> | undefined =>
  readEntry<unknown>(brevisKey(chainId))

export const readFuul = (chainId: number, protocol: FuulProtocol): CachedEntry<unknown> | undefined =>
  readEntry<unknown>(fuulKey(chainId, protocol))

// --- Background revalidation helper ---------------------------------------

/**
 * Fire-and-forget background revalidation. Used by handlers when serving
 * stale: kick the refresh, swallow the error (logWarn for observability),
 * return the stale payload synchronously.
 */
export const scheduleRevalidation = (context: string, refresh: () => Promise<unknown>): void => {
  void refresh().catch((err) => {
    logWarn('rewards-cache', `${context} background revalidate failed:`, err instanceof Error ? err.message : err)
  })
}
