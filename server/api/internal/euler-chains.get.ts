import { setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { createTtlCache } from '~/server/utils/cache'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { createInFlightDedup } from '~/server/utils/in-flight'
import {
  MANIFEST_MAX_STALE_MS,
  eulerInterfacesRawUrl,
} from '~/server/utils/euler-interfaces'
import { logger } from '~/server/utils/logger'
import eulerChainsSnapshot from '~/server/assets/manifests/EulerChains.json'

const CACHE_TTL_MS = 300_000

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'euler-chains',
})

const cache = createTtlCache<unknown[]>({
  ttlMs: CACHE_TTL_MS,
  maxStaleMs: MANIFEST_MAX_STALE_MS,
})
const CACHE_KEY = 'euler-chains'
const inFlight = createInFlightDedup<string, unknown[]>()

function getUpstreamUrl(): string {
  // An explicit full URL is the most specific override (and the emergency
  // repoint lever during an upstream outage), so it wins over the branch
  // env vars, which merely select a branch of the default GitHub source.
  const explicitUrl = (process.env.NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL || '').trim()
  if (explicitUrl) return explicitUrl

  return eulerInterfacesRawUrl('EulerChains.json')
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

/**
 * Full resolution chain: fresh cache → upstream → stale cache → build-time
 * snapshot (refreshed via `npm run snapshots:update`). The snapshot is the
 * cold-start last resort: a process that boots during an upstream outage
 * still serves a working, if dated, deployment manifest instead of taking
 * every SDK build down with it. Also installed as the deployments source
 * for server-side SDK builds (see server/plugins/sdk-deployments.ts).
 */
export async function loadEulerChains(): Promise<unknown[]> {
  const cached = cache.get(CACHE_KEY)
  if (cached) return cached

  try {
    return await refreshEulerChains()
  }
  catch (err) {
    logger.warn({ ctx: 'euler-chains', err }, 'upstream fetch failed')

    const stale = cache.getStale(CACHE_KEY)
    if (stale) return stale

    logger.error(
      { ctx: 'euler-chains' },
      'no cached deployment manifest; serving build-time snapshot',
    )
    return eulerChainsSnapshot
  }
}

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')

  return loadEulerChains()
})
