import { createError, getQuery } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { createTtlCache } from '~/server/utils/cache'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { logWarn } from '~/server/utils/log'

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

  const baseUrl = process.env.EULER_API_URL || process.env.NUXT_PUBLIC_EULER_API_URL
  if (!baseUrl) return Promise.resolve([])

  const PAGE_LIMIT = 100

  const promise = (async () => {
    const allTokens: EulerApiToken[] = []
    let offset = 0
    let hasMore = true

    while (hasMore) {
      const resp = await fetchWithTimeout(
        `${baseUrl}/v3/tokens?chainId=${chainId}&limit=${PAGE_LIMIT}&offset=${offset}`,
        TIMEOUT_MS,
      )
      if (!resp.ok) throw new Error(`Euler API returned ${resp.status}`)

      const body = await resp.json()
      const page: EulerApiToken[] = body.data || []
      allTokens.push(...page)
      offset += PAGE_LIMIT
      hasMore = body.meta?.hasMore === true
        || (body.meta?.total != null && offset < body.meta.total)
    }

    const tokens: TokenEntry[] = allTokens.map(t => ({
      chainId: t.chainId,
      address: t.address,
      name: t.name,
      symbol: t.symbol,
      decimals: t.decimals,
      logoURI: t.logoURI || undefined,
    }))
    eulerApiCache.set(key, tokens)
    return tokens
  })()
    .catch((err: unknown) => {
      logWarn('token-list', 'Euler API fetch failed:', err instanceof Error ? err.message : err, 'for chain', chainId)
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
      return tokens
    })
    .catch((err: unknown) => {
      logWarn('token-list', 'Uniswap fetch failed:', err instanceof Error ? err.message : err)
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
      return tokens
    })
    .catch((err: unknown) => {
      logWarn('token-list', 'DefiLlama fetch failed:', err instanceof Error ? err.message : err, 'for chain', chainId)
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

  // --- Primary source: Euler API (always awaited) ---
  const euler = await fetchEulerApi(chainId)

  // --- Supplemental: Uniswap (best-effort, non-blocking) ---
  let uniswap = uniswapCache.get('all')
  if (uniswap === undefined) {
    void fetchUniswap()
    uniswap = uniswapCache.getStale('all') ?? []
  }

  // --- Supplemental: DefiLlama (best-effort, non-blocking) ---
  const key = String(chainId)
  let defillama = defillamaCache.get(key)
  if (defillama === undefined) {
    void fetchDefillama(chainId)
    defillama = defillamaCache.getStale(key) ?? []
  }

  // Priority: Euler API > DefiLlama > Uniswap
  const tokens = deduplicateTokens(euler, deduplicateTokens(defillama, uniswap))

  if (tokens.length === 0) {
    throw createError({ statusCode: 502, statusMessage: 'Upstream error' })
  }

  return { tokens }
})
