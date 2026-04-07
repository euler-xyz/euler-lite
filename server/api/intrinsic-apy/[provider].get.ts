import { createError, getRouterParam, getQuery } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { createTtlCache } from '~/server/utils/cache'
import { logWarn } from '~/server/utils/log'

const TIMEOUT_MS = 10_000
const CACHE_TTL_MS = 5 * 60 * 1000

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'intrinsic-apy-proxy',
})

const PROVIDER_URLS: Record<string, string> = {
  defillama: 'https://yields.llama.fi/pools',
  etherfi: 'https://app.ether.fi/api/protocol/protocol-detail',
  puffer: 'https://api-v2.puffer.fi/backend-for-frontend/tvl/all',
  treehouse: 'https://api.treehouse.finance/apy',
  spark: 'https://info-sky.blockanalitica.com/api/v1/overall/?format=json',
  benqi: 'https://api.benqi.fi/liquidstaking/apr',
  avant: 'https://app.avantprotocol.com/api/savusdApy',
  ondo: 'https://ondo.finance/api/v1/assets',
  renzo: 'https://app.renzoprotocol.com/api/stats',
  midas: 'https://api-prod.midas.app/api/data/apys',
  yo: 'https://api.yo.xyz/api/v1/vault/stats',
  securitize: 'https://public-feed.securitize.io/asset-stats',
  stablewatch: 'https://api.stablewatch.io/api/pools',
}

const PENDLE_API_BASE = 'https://api-v2.pendle.finance/core/v2'

const cache = createTtlCache<unknown>({ ttlMs: CACHE_TTL_MS, maxEntries: 200 })
const inFlight = new Map<string, Promise<unknown>>()

const fetchUpstream = (url: string, cacheKey: string): Promise<unknown> => {
  const existing = inFlight.get(cacheKey)
  if (existing) return existing

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS)

  const promise = fetch(url, { signal: controller.signal })
    .then(async (resp) => {
      if (!resp.ok) {
        throw createError({ statusCode: 502, statusMessage: `Upstream returned ${resp.status}` })
      }
      const data = await resp.json()
      cache.set(cacheKey, data)
      return data
    })
    .finally(() => {
      clearTimeout(timeout)
      inFlight.delete(cacheKey)
    })

  inFlight.set(cacheKey, promise)
  return promise
}

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const provider = getRouterParam(event, 'provider')
  if (!provider) {
    throw createError({ statusCode: 400, statusMessage: 'Missing provider' })
  }

  const query = getQuery(event)

  let url: string
  let cacheKey: string

  if (provider === 'stablewatch') {
    const apiKey = process.env.STABLEWATCH_API_KEY
    if (!apiKey) {
      return { data: [] }
    }
    const stablewatchUrl = new URL(PROVIDER_URLS.stablewatch)
    stablewatchUrl.searchParams.set('api_key', apiKey)
    url = stablewatchUrl.toString()
    cacheKey = 'stablewatch'
  }
  else if (provider === 'pendle') {
    const chainId = typeof query.chainId === 'string' ? query.chainId : undefined
    const market = typeof query.market === 'string' ? query.market : undefined
    if (!chainId || !/^\d+$/.test(chainId) || !market || !/^0x[a-fA-F0-9]{40}$/.test(market)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid pendle params' })
    }
    url = `${PENDLE_API_BASE}/${chainId}/markets/${market}/data`
    cacheKey = `pendle:${chainId}:${market.toLowerCase()}`
  }
  else if (provider === 'securitize') {
    const symbol = typeof query.symbol === 'string' ? query.symbol.trim() : undefined
    if (!symbol) {
      throw createError({ statusCode: 400, statusMessage: 'Missing symbol param' })
    }
    const normalizedSymbol = symbol.toUpperCase()
    url = `${PROVIDER_URLS.securitize}?symbol=${encodeURIComponent(normalizedSymbol)}`
    cacheKey = `securitize:${normalizedSymbol}`
  }
  else {
    const baseUrl = PROVIDER_URLS[provider]
    if (!baseUrl) {
      throw createError({ statusCode: 404, statusMessage: 'Unknown provider' })
    }
    url = baseUrl
    cacheKey = provider
  }

  const fresh = cache.get(cacheKey)
  if (fresh !== undefined) {
    return fresh
  }

  const stale = cache.getStale(cacheKey)
  if (stale !== undefined) {
    void fetchUpstream(url, cacheKey).catch((err) => {
      logWarn(`intrinsic-apy/${provider}`, 'background revalidation failed:', err instanceof Error ? err.message : err)
    })
    return stale
  }

  // Cold — await
  try {
    return await fetchUpstream(url, cacheKey)
  }
  catch (error) {
    if (error && typeof error === 'object' && 'statusCode' in error) {
      throw error
    }
    logWarn(`intrinsic-apy/${provider}`, 'upstream error:', error instanceof Error ? error.message : error)
    throw createError({ statusCode: 502, statusMessage: 'Upstream error' })
  }
})
