import { createError, setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { createTtlCache } from '~/server/utils/cache'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { createInFlightDedup } from '~/server/utils/in-flight'
import {
  MANIFEST_MAX_STALE_MS,
  eulerInterfacesRawUrl,
} from '~/server/utils/euler-interfaces'
import { logger } from '~/server/utils/logger'

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

// Admission check guarding the long stale window: only a manifest the SDK
// and useEulerAddresses can actually consume may overwrite the last-known-
// good entry. An array-shaped but unusable 200 (`[]`, `[{ chainId, addresses:
// {} }]`, non-address values) must throw so loadEulerChains() keeps serving
// the previous stale value instead of preserving poison for up to
// MANIFEST_MAX_STALE_MS.
//
// Required keys are the ones whose absence breaks SDK builds or the core
// lend/borrow surfaces on every chain (all current manifest entries carry
// the full key set; peripheral keys are deliberately not required so a
// sparse future entry degrades a feature, not the whole manifest).
const REQUIRED_CORE_ADDRS = ['eVaultFactory', 'evc', 'permit2'] as const
const REQUIRED_LENS_ADDRS = ['accountLens', 'oracleLens', 'utilsLens', 'vaultLens'] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isEvmAddress = (value: unknown): boolean =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)

const isValidDeployment = (entry: unknown): boolean => {
  if (!isRecord(entry)) return false
  const { chainId, addresses } = entry
  if (!Number.isInteger(chainId) || (chainId as number) <= 0) return false
  if (!isRecord(addresses)) return false

  const { coreAddrs, lensAddrs } = addresses
  if (!isRecord(coreAddrs) || !isRecord(lensAddrs)) return false

  return REQUIRED_CORE_ADDRS.every(key => isEvmAddress(coreAddrs[key]))
    && REQUIRED_LENS_ADDRS.every(key => isEvmAddress(lensAddrs[key]))
}

const isValidDeploymentManifest = (data: unknown): data is unknown[] =>
  Array.isArray(data) && data.length > 0 && data.every(isValidDeployment)

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
    if (!isValidDeploymentManifest(data)) {
      throw new Error('Upstream returned an invalid deployment manifest')
    }
    cache.set(CACHE_KEY, data)
    return data
  })
}

/**
 * Full resolution chain: fresh cache → upstream → stale cache (long
 * manifest window). Throws only when upstream is down and no copy has been
 * cached within the stale window — i.e. a process cold-started mid-outage;
 * repoint via NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL in that case. Also
 * installed as the deployments source for every server-side SDK build (see
 * server/plugins/sdk-deployments.ts).
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
      'upstream unavailable and no cached deployment manifest to serve',
    )
    throw err
  }
}

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')

  try {
    return await loadEulerChains()
  }
  catch {
    throw createError({ statusCode: 502, statusMessage: 'Upstream error' })
  }
})
