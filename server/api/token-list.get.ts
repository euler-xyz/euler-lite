import { createError, getQuery } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { createTtlCache } from '~/server/utils/cache'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { reportStatus } from '~/server/utils/log'
import { getMerklRewardTokensForChain } from '~/server/utils/rewards-cache'

const TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 300_000
const DEFILLAMA_DEFAULT_URL = 'https://d3g10bzo9rdluh.cloudfront.net'

interface EulerApiToken {
  chainId: number
  address: string
  name: string
  symbol: string
  decimals: number
  logoURI: string
  metadata?: { provider: string }
}

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

const eulerApiCache = createTtlCache<TokenEntry[]>({ ttlMs: CACHE_TTL_MS })
const uniswapCache = createTtlCache<TokenEntry[]>({ ttlMs: CACHE_TTL_MS })
const defillamaCache = createTtlCache<TokenEntry[]>({ ttlMs: CACHE_TTL_MS })

const eulerInFlight = new Map<string, Promise<TokenEntry[]>>()
const uniswapInFlight = new Map<string, Promise<TokenEntry[]>>()
const defillamaInFlight = new Map<string, Promise<TokenEntry[]>>()

function fetchEulerApi(chainId: number): Promise<TokenEntry[]> {
  const key = String(chainId)
  const cached = eulerApiCache.get(key)
  if (cached) return Promise.resolve(cached)

  const existing = eulerInFlight.get(key)
  if (existing) return existing

  const url = process.env.EULER_API_URL || process.env.NUXT_PUBLIC_EULER_API_URL
  if (!url) return Promise.resolve([])

  const promise = fetchWithTimeout(`${url}/v1/tokens?chainId=${chainId}`, TIMEOUT_MS)
    .then(async (resp) => {
      if (!resp.ok) throw new Error(`Euler API returned ${resp.status}`)
      const data = (await resp.json()) as EulerApiToken[]
      const tokens: TokenEntry[] = data.map(t => ({
        chainId: t.chainId,
        address: t.address,
        name: t.name,
        symbol: t.symbol,
        decimals: t.decimals,
        logoURI: t.logoURI || undefined,
      }))
      eulerApiCache.set(key, tokens)
      reportStatus('token-list', `euler-api:${chainId}`, 'ok')
      return tokens
    })
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err)
      reportStatus('token-list', `euler-api:${chainId}`, `failed:${msg}`,
        `Euler API fetch failed for chain ${chainId}: ${msg}`)
      return eulerApiCache.getStale(key) || []
    })
    .finally(() => { eulerInFlight.delete(key) })

  eulerInFlight.set(key, promise)
  return promise
}

function fetchUniswap(): Promise<TokenEntry[]> {
  const url = process.env.NUXT_PUBLIC_CONFIG_UNISWAP_TOKEN_LIST_URL || 'https://tokens.uniswap.org'

  const cached = uniswapCache.get('all')
  if (cached) return Promise.resolve(cached)

  const existing = uniswapInFlight.get('all')
  if (existing) return existing

  const promise = fetchWithTimeout(url, TIMEOUT_MS)
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
    })
    .finally(() => { uniswapInFlight.delete('all') })

  uniswapInFlight.set('all', promise)
  return promise
}

function fetchDefillama(chainId: number): Promise<TokenEntry[]> {
  const key = String(chainId)
  const cached = defillamaCache.get(key)
  if (cached) return Promise.resolve(cached)

  const existing = defillamaInFlight.get(key)
  if (existing) return existing

  const baseUrl = process.env.NUXT_PUBLIC_CONFIG_DEFILLAMA_TOKEN_LIST_URL || DEFILLAMA_DEFAULT_URL
  const url = `${baseUrl}/tokenlists-${chainId}.json`

  const promise = fetchWithTimeout(url, TIMEOUT_MS)
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
    })
    .finally(() => { defillamaInFlight.delete(key) })

  defillamaInFlight.set(key, promise)
  return promise
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

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const query = getQuery(event)
  const chainId = Number(query.chainId)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'chainId is required and must be a positive integer' })
  }

  // Fetch all four sources concurrently. Each fetcher already reads its own
  // cache first, dedups in-flight requests, and resolves to stale/empty on
  // error — allSettled never rejects. The response is bounded by the slowest
  // cold-fetch (10s timeout); on a warm cache this returns immediately.
  // Merkl reward tokens share the rewards-cache state used by warm-cache,
  // so this is usually a synchronous read from a hot cache.
  const [eulerResult, uniswapResult, defillamaResult, merklResult] = await Promise.allSettled([
    fetchEulerApi(chainId),
    fetchUniswap(),
    fetchDefillama(chainId),
    getMerklRewardTokensForChain(chainId),
  ])

  const euler = eulerResult.status === 'fulfilled' ? eulerResult.value : []
  const uniswap = uniswapResult.status === 'fulfilled' ? uniswapResult.value : []
  const defillama = defillamaResult.status === 'fulfilled' ? defillamaResult.value : []
  const merkl = merklResult.status === 'fulfilled' ? merklResult.value : []

  // Priority: Euler API > DefiLlama > Uniswap > Merkl rewards. Merkl sits
  // last so it only fills in tokens the general sources don't know about,
  // without overriding authoritative metadata for tokens (like EUL) that
  // are in multiple lists.
  const tokens = deduplicateTokens(
    euler,
    deduplicateTokens(defillama, deduplicateTokens(uniswap, merkl)),
  )

  if (tokens.length === 0) {
    throw createError({ statusCode: 502, statusMessage: 'Upstream error' })
  }

  return { tokens }
})
