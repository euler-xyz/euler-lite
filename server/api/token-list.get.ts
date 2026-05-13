import { createError, getQuery, setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { createTtlCache } from '~/server/utils/cache'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { createInFlightDedup } from '~/server/utils/in-flight'
import { reportStatus } from '~/server/utils/log'
import { MERKL_API_BASE_URL } from '~/entities/constants'
import { buildEulerSDK, type EulerSDK, type TokenListItem } from '@eulerxyz/euler-v2-sdk'
import { readV3ApiUrl } from '~/utils/api-url-env'

const CACHE_TTL_MS = 300_000
const DEFILLAMA_DEFAULT_URL = 'https://d3g10bzo9rdluh.cloudfront.net'

interface TokenEntry {
  chainId: number
  address: string
  name: string
  symbol: string
  decimals: number
  logoURI?: string
}

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'token-list',
})

const eulerSdkCache = createTtlCache<TokenEntry[]>({ ttlMs: CACHE_TTL_MS })
const uniswapCache = createTtlCache<TokenEntry[]>({ ttlMs: CACHE_TTL_MS })
const defillamaCache = createTtlCache<TokenEntry[]>({ ttlMs: CACHE_TTL_MS })
const merklCache = createTtlCache<TokenEntry[]>({ ttlMs: CACHE_TTL_MS })

const eulerInFlight = createInFlightDedup<string, TokenEntry[]>()
const uniswapInFlight = createInFlightDedup<string, TokenEntry[]>()
const defillamaInFlight = createInFlightDedup<string, TokenEntry[]>()
const merklInFlight = createInFlightDedup<string, TokenEntry[]>()

/**
 * Handler-level cache for the merged per-chain token list. Without it every
 * request re-resolves all four sources (cached but await-chained) and re-runs
 * the four-way dedup over thousands of entries. With it, steady-state reads
 * are a single Map lookup after the first merge.
 */
const mergedCache = createTtlCache<TokenEntry[]>({ ttlMs: CACHE_TTL_MS, maxEntries: 50 })
const mergedInFlight = createInFlightDedup<string, TokenEntry[]>()

let sdkPromise: Promise<EulerSDK> | undefined

function getV3ApiUrl(): string | undefined {
  return readV3ApiUrl()
    .trim()
    .replace(/\/+$/, '') || undefined
}

const getSdk = () => {
  const v3ApiUrl = getV3ApiUrl()
  sdkPromise ??= buildEulerSDK({
    ...(v3ApiUrl ? { config: { v3ApiUrl, tokenlistApiBaseUrl: v3ApiUrl } } : {}),
  })
  return sdkPromise
}

const toTokenEntry = (token: TokenListItem): TokenEntry => ({
  chainId: token.chainId,
  address: token.address,
  name: token.name,
  symbol: token.symbol,
  decimals: token.decimals,
  logoURI: token.logoURI || undefined,
})

function refreshEulerSdkTokenList(chainId: number): Promise<TokenEntry[]> {
  const key = String(chainId)

  return eulerInFlight.run(key, () => getSdk()
    .then(async (sdk) => {
      const tokens = (await sdk.tokenlistService.loadTokenlist(chainId)).map(toTokenEntry)
      eulerSdkCache.set(key, tokens)
      reportStatus('token-list', `euler-sdk:${chainId}`, 'ok')
      return tokens
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      reportStatus('token-list', `euler-sdk:${chainId}`, `failed:${msg}`,
        `Euler SDK token list failed for chain ${chainId}: ${msg}`)
      return eulerSdkCache.getStale(key) || []
    }))
}

function fetchEulerSdkTokenList(chainId: number): Promise<TokenEntry[]> {
  const cached = eulerSdkCache.get(String(chainId))
  if (cached) return Promise.resolve(cached)
  return refreshEulerSdkTokenList(chainId)
}

function refreshUniswap(): Promise<TokenEntry[]> {
  const url = process.env.NUXT_PUBLIC_CONFIG_UNISWAP_TOKEN_LIST_URL || 'https://tokens.uniswap.org'

  return uniswapInFlight.run('all', () => fetchWithTimeout(url)
    .then(async (resp) => {
      if (!resp.ok) throw new Error(`Uniswap upstream returned ${resp.status}`)
      const data = await resp.json()
      const tokens: TokenEntry[] = data.tokens || []
      uniswapCache.set('all', tokens)
      reportStatus('token-list', 'uniswap:all', 'ok')
      return tokens
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      reportStatus('token-list', 'uniswap:all', `failed:${msg}`,
        `Uniswap fetch failed: ${msg}`)
      return uniswapCache.getStale('all') || []
    }))
}

function fetchUniswap(): Promise<TokenEntry[]> {
  const cached = uniswapCache.get('all')
  if (cached) return Promise.resolve(cached)
  return refreshUniswap()
}

function refreshDefillama(chainId: number): Promise<TokenEntry[]> {
  const key = String(chainId)
  const baseUrl = process.env.NUXT_PUBLIC_CONFIG_DEFILLAMA_TOKEN_LIST_URL || DEFILLAMA_DEFAULT_URL
  const url = `${baseUrl}/tokenlists-${chainId}.json`

  return defillamaInFlight.run(key, () => fetchWithTimeout(url)
    .then(async (resp) => {
      if (!resp.ok) throw new Error(`DefiLlama upstream returned ${resp.status}`)
      const data = await resp.json()
      // DefiLlama format: object keyed by address → normalize to array
      const tokens: TokenEntry[] = (Object.values(data) as Record<string, unknown>[]).map(entry => ({
        chainId: Number(entry.chainId) || chainId,
        address: entry.address as string,
        name: entry.name as string,
        symbol: entry.symbol as string,
        decimals: entry.decimals as number,
        logoURI: (entry.logoURI || entry.logoURI2) as string | undefined,
      }))
      defillamaCache.set(key, tokens)
      reportStatus('token-list', `defillama:${chainId}`, 'ok')
      return tokens
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      reportStatus('token-list', `defillama:${chainId}`, `failed:${msg}`,
        `DefiLlama fetch failed for chain ${chainId}: ${msg}`)
      return defillamaCache.getStale(key) || []
    }))
}

function fetchDefillama(chainId: number): Promise<TokenEntry[]> {
  const cached = defillamaCache.get(String(chainId))
  if (cached) return Promise.resolve(cached)
  return refreshDefillama(chainId)
}

// Merkl publishes a single global payload `{ [chainId]: RewardToken[] }`.
// One in-flight promise shared across all chain-keyed callers collapses
// the multi-chain warm-cycle into a single HTTP round-trip; each chain
// caches its own filtered subset so reads are O(1) per chain.
let merklGlobalInFlight: Promise<Record<string, unknown[]>> | null = null

function fetchMerklGlobal(): Promise<Record<string, unknown[]>> {
  if (merklGlobalInFlight) return merklGlobalInFlight
  merklGlobalInFlight = fetchWithTimeout(`${MERKL_API_BASE_URL}/tokens/reward`)
    .then(async (resp) => {
      if (!resp.ok) throw new Error(`Merkl tokens upstream returned ${resp.status}`)
      return await resp.json() as Record<string, unknown[]>
    })
    .finally(() => { merklGlobalInFlight = null })
  return merklGlobalInFlight
}

function refreshMerkl(chainId: number): Promise<TokenEntry[]> {
  const key = String(chainId)

  return merklInFlight.run(key, () => fetchMerklGlobal()
    .then((data) => {
      const raw = data[key]
      if (!Array.isArray(raw)) return []
      const tokens: TokenEntry[] = raw
        .filter((e): e is Record<string, unknown> => !!e && typeof e === 'object')
        .map(t => ({
          chainId,
          address: typeof t.address === 'string' ? t.address : '',
          name: typeof t.name === 'string' ? t.name : (typeof t.symbol === 'string' ? t.symbol : ''),
          symbol: typeof t.symbol === 'string' ? t.symbol : '',
          decimals: typeof t.decimals === 'number' ? t.decimals : Number(t.decimals ?? 18),
          logoURI: typeof t.icon === 'string' ? t.icon : undefined,
        }))
        .filter(t => t.address)
      merklCache.set(key, tokens)
      reportStatus('token-list', `merkl:${chainId}`, 'ok')
      return tokens
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      reportStatus('token-list', `merkl:${chainId}`, `failed:${msg}`,
        `Merkl fetch failed for chain ${chainId}: ${msg}`)
      return merklCache.getStale(key) || []
    }))
}

function fetchMerkl(chainId: number): Promise<TokenEntry[]> {
  const cached = merklCache.get(String(chainId))
  if (cached) return Promise.resolve(cached)
  return refreshMerkl(chainId)
}

/** Merge two token arrays, deduplicating by chain+address. Primary entries take precedence. */
function deduplicateTokens(primary: TokenEntry[], secondary: TokenEntry[]): TokenEntry[] {
  const seen = new Set<string>()
  const result: TokenEntry[] = []

  for (const token of primary) {
    const key = `${token.chainId}:${token.address.toLowerCase()}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push(token)
    }
  }

  for (const token of secondary) {
    const key = `${token.chainId}:${token.address.toLowerCase()}`
    if (!seen.has(key)) {
      seen.add(key)
      result.push(token)
    }
  }

  return result
}

const mergeSources = (
  eulerResult: PromiseSettledResult<TokenEntry[]>,
  uniswapResult: PromiseSettledResult<TokenEntry[]>,
  defillamaResult: PromiseSettledResult<TokenEntry[]>,
  merklResult: PromiseSettledResult<TokenEntry[]>,
): TokenEntry[] => {
  const euler = eulerResult.status === 'fulfilled' ? eulerResult.value : []
  const uniswap = uniswapResult.status === 'fulfilled' ? uniswapResult.value : []
  const defillama = defillamaResult.status === 'fulfilled' ? defillamaResult.value : []
  const merkl = merklResult.status === 'fulfilled' ? merklResult.value : []

  // Priority: Euler SDK token list > DefiLlama > Uniswap > Merkl rewards. Merkl sits
  // last so it only fills in tokens the general sources don't know about,
  // without overriding authoritative metadata for tokens (like EUL) that
  // are in multiple lists.
  return deduplicateTokens(
    euler,
    deduplicateTokens(defillama, deduplicateTokens(uniswap, merkl)),
  )
}

const buildMergedTokens = async (chainId: number): Promise<TokenEntry[]> => {
  // Fetch all four sources concurrently. Each fetcher has its own cache,
  // in-flight dedup, and stale-fallback (via allSettled so one failure
  // doesn't kill the merge). Bounded by the slowest cold-fetch (10s
  // timeout); warm-cache path is a Map lookup.
  const [eulerResult, uniswapResult, defillamaResult, merklResult] = await Promise.allSettled([
    fetchEulerSdkTokenList(chainId),
    fetchUniswap(),
    fetchDefillama(chainId),
    fetchMerkl(chainId),
  ])
  return mergeSources(eulerResult, uniswapResult, defillamaResult, merklResult)
}

/**
 * Forces an upstream fetch of every source AND a merged-cache rebuild,
 * bypassing the fresh-cache short-circuits at every layer. Used by the
 * warm-cache plugin so every cycle actually refreshes the entries
 * instead of cache-hitting still-fresh values and letting them expire
 * before the next cycle.
 *
 * During the refresh window, user requests continue to see the previous
 * fresh entry via the handler's `mergedCache.get()` short-circuit.
 */
export function refreshTokenList(chainId: number): Promise<TokenEntry[]> {
  const key = String(chainId)
  return mergedInFlight.run(key, async () => {
    const results = await Promise.allSettled([
      refreshEulerSdkTokenList(chainId),
      refreshUniswap(),
      refreshDefillama(chainId),
      refreshMerkl(chainId),
    ])
    const merged = mergeSources(results[0], results[1], results[2], results[3])
    if (merged.length > 0) mergedCache.set(key, merged)
    return merged
  })
}

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const query = getQuery(event)
  const chainId = Number(query.chainId)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'chainId is required and must be a positive integer' })
  }

  const key = String(chainId)
  const fresh = mergedCache.get(key)
  const tokens = fresh ?? await mergedInFlight.run(key, async () => {
    const result = await buildMergedTokens(chainId)
    if (result.length > 0) mergedCache.set(key, result)
    return result
  })

  if (tokens.length === 0) {
    const stale = mergedCache.getStale(key)
    if (stale && stale.length > 0) {
      setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')
      return { tokens: stale }
    }
    throw createError({ statusCode: 502, statusMessage: 'Upstream error' })
  }

  setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')
  return { tokens }
})
