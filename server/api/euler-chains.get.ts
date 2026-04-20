import { createError, setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { createTtlCache } from '~/server/utils/cache'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { logWarn } from '~/server/utils/log'

const CACHE_TTL_MS = 300_000
const DEFAULT_URL = 'https://raw.githubusercontent.com/euler-xyz/euler-interfaces/refs/heads/master/EulerChains.json'

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'euler-chains',
})

const cache = createTtlCache<unknown[]>({ ttlMs: CACHE_TTL_MS })
const CACHE_KEY = 'euler-chains'
/** Collapses concurrent cache-miss callers (warm-cache racing client requests) onto one upstream fetch. */
let inFlight: Promise<unknown[]> | null = null

function getUpstreamUrl(): string {
  return (process.env.NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL || '').trim() || DEFAULT_URL
}

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')

  const cached = cache.get(CACHE_KEY)
  if (cached) return cached

  if (inFlight) return inFlight

  inFlight = (async () => {
    try {
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
    }
    catch (err) {
      logWarn('euler-chains', 'Upstream fetch failed:', err instanceof Error ? err.message : err)

      const stale = cache.getStale(CACHE_KEY)
      if (stale) return stale

      throw createError({ statusCode: 502, statusMessage: 'Upstream error' })
    }
  })().finally(() => { inFlight = null })

  return inFlight
})
