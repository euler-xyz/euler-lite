import { createError, setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { createTtlCache } from '~/server/utils/cache'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { createInFlightDedup } from '~/server/utils/in-flight'
import { logger } from '~/server/utils/logger'

const CACHE_TTL_MS = 300_000
const DEFAULT_URL = 'https://raw.githubusercontent.com/euler-xyz/euler-interfaces/refs/heads/master/EulerChains.json'

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'euler-chains',
})

const cache = createTtlCache<unknown[]>({ ttlMs: CACHE_TTL_MS })
const CACHE_KEY = 'euler-chains'
const inFlight = createInFlightDedup<string, unknown[]>()

function getUpstreamUrl(): string {
  return (process.env.NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL || '').trim() || DEFAULT_URL
}

/**
 * Forces an upstream fetch, bypassing the fresh-cache check. Used by the
 * warm-cache plugin so every cycle actually refreshes the entry instead
 * of cache-hitting a still-fresh value and letting it expire before the
 * next cycle. Collapses concurrent refresh calls onto one in-flight promise.
 */
export function refreshEulerChains(): Promise<unknown[]> {
  return inFlight.run(CACHE_KEY, async () => {
    const resp = await fetchWithTimeout(getUpstreamUrl())
    if (!resp.ok) {
      throw new Error(`Upstream returned ${resp.status}`)
    }

    const data: unknown = await resp.json()
    if (!Array.isArray(data)) {
      throw new Error('Upstream returned a non-array payload')
    }
    cache.set(CACHE_KEY, data)
    return data
  })
}

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')

  const cached = cache.get(CACHE_KEY)
  if (cached) return cached

  try {
    return await refreshEulerChains()
  }
  catch (err) {
    logger.warn({ ctx: 'euler-chains', err }, 'upstream fetch failed')

    const stale = cache.getStale(CACHE_KEY)
    if (stale) return stale

    throw createError({ statusCode: 502, statusMessage: 'Upstream error' })
  }
})
