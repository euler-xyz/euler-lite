import { createError, getQuery } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { createTtlCache } from '~/server/utils/cache'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'

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

async function fetchEulerApi(chainId: number): Promise<TokenEntry[]> {
  const key = String(chainId)
  const cached = eulerApiCache.get(key)
  if (cached) return cached

  try {
    const baseUrl = process.env.EULER_API_URL || process.env.NUXT_PUBLIC_EULER_API_URL
    if (!baseUrl) return []

    const PAGE_LIMIT = 100
    const allTokens: EulerApiToken[] = []
    let offset = 0
    let hasMore = true

    while (hasMore) {
      const resp = await fetchWithTimeout(
        `${baseUrl}/v3/tokens?chainId=${chainId}&limit=${PAGE_LIMIT}&offset=${offset}`,
        TIMEOUT_MS,
      )
      if (!resp.ok) {
        throw new Error(`Euler API returned ${resp.status}`)
      }

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
  }
  catch (err) {
    console.warn('[token-list] Euler API fetch failed:', err instanceof Error ? err.message : err, 'for chain', chainId)
    return eulerApiCache.getStale(key) || []
  }
}

async function fetchUniswap(): Promise<TokenEntry[]> {
  const url = process.env.NUXT_PUBLIC_CONFIG_UNISWAP_TOKEN_LIST_URL || 'https://tokens.uniswap.org'

  const cached = uniswapCache.get('all')
  if (cached) return cached

  const resp = await fetchWithTimeout(url, TIMEOUT_MS)
  if (!resp.ok) {
    console.warn('[token-list] Uniswap upstream returned', resp.status)
    throw new Error(`Uniswap upstream returned ${resp.status}`)
  }

  const data = await resp.json()
  const tokens: TokenEntry[] = data.tokens || []
  uniswapCache.set('all', tokens)
  return tokens
}

async function fetchDefillama(chainId: number): Promise<TokenEntry[]> {
  const key = String(chainId)
  const cached = defillamaCache.get(key)
  if (cached) return cached

  try {
    const baseUrl = process.env.NUXT_PUBLIC_CONFIG_DEFILLAMA_TOKEN_LIST_URL || DEFILLAMA_DEFAULT_URL
    const url = `${baseUrl}/tokenlists-${chainId}.json`
    const resp = await fetchWithTimeout(url, TIMEOUT_MS)
    if (!resp.ok) {
      throw new Error(`DefiLlama upstream returned ${resp.status}`)
    }

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
  }
  catch (err) {
    console.warn('[token-list] DefiLlama fetch failed:', err instanceof Error ? err.message : err, 'for chain', chainId)
    return defillamaCache.getStale(key) || []
  }
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
  const chainId = query.chainId ? Number(query.chainId) : null

  // Fetch all sources in parallel; Euler API and DefiLlama are best-effort
  const [eulerResult, uniswapResult, defillamaResult] = await Promise.allSettled([
    chainId ? fetchEulerApi(chainId) : Promise.resolve([]),
    fetchUniswap(),
    chainId ? fetchDefillama(chainId) : Promise.resolve([]),
  ])

  const eulerTokens = eulerResult.status === 'fulfilled' ? eulerResult.value : []

  if (uniswapResult.status === 'rejected') {
    console.warn('[token-list] Uniswap fetch failed:', uniswapResult.reason?.message || 'Unknown error')

    // If we have stale Uniswap cache, use it
    const stale = uniswapCache.getStale('all')
    if (stale) {
      const defillamaTokens = defillamaResult.status === 'fulfilled' ? defillamaResult.value : []
      return { tokens: deduplicateTokens(eulerTokens, deduplicateTokens(defillamaTokens, stale)) }
    }

    // No Uniswap data at all — still return Euler + DefiLlama if available
    const defillamaTokens = defillamaResult.status === 'fulfilled' ? defillamaResult.value : []
    if (eulerTokens.length > 0 || defillamaTokens.length > 0) {
      return { tokens: deduplicateTokens(eulerTokens, defillamaTokens) }
    }

    throw createError({ statusCode: 502, statusMessage: 'Upstream error' })
  }

  const uniswapTokens = uniswapResult.value
  const defillamaTokens = defillamaResult.status === 'fulfilled' ? defillamaResult.value : []

  // Priority: Euler API > DefiLlama > Uniswap
  return { tokens: deduplicateTokens(eulerTokens, deduplicateTokens(defillamaTokens, uniswapTokens)) }
})
