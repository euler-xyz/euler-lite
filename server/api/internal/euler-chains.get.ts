import { createError, setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { createTtlCache } from '~/server/utils/cache'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { createInFlightDedup } from '~/server/utils/in-flight'
import {
  MANIFEST_MAX_STALE_MS,
  eulerInterfacesRawUrl,
} from '~/server/utils/euler-interfaces'
import { getEnabledChainIds } from '~/utils/chain-env'
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
// Admission is per entry: an invalid entry for a chain this deployment does
// not enable is dropped with a warning (a routine euler-interfaces commit
// adding a sparse new chain must not freeze the manifest and time-bomb a
// total 502 when the stale window expires), while every enabled chain must
// be present and valid — an unusable payload for a chain users are actually
// on is exactly the poison the stale window exists to outlive.
//
// Required keys are the ones whose absence breaks SDK builds or the core
// lend/borrow surfaces on every chain (all current manifest entries carry
// the full key set; peripheral keys are deliberately not required so a
// sparse entry degrades a feature, not the chain).
const REQUIRED_CORE_ADDRS = ['eVaultFactory', 'evc', 'permit2'] as const
const REQUIRED_LENS_ADDRS = ['accountLens', 'oracleLens', 'utilsLens', 'vaultLens'] as const

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

const isEvmAddress = (value: unknown): boolean =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{40}$/.test(value)

const readChainId = (entry: unknown): number | undefined => {
  if (!isRecord(entry)) return undefined
  const { chainId } = entry
  return Number.isInteger(chainId) && (chainId as number) > 0 ? chainId as number : undefined
}

const isValidDeployment = (entry: unknown): boolean => {
  if (!isRecord(entry)) return false
  if (readChainId(entry) === undefined) return false
  const { addresses } = entry
  if (!isRecord(addresses)) return false

  const { coreAddrs, lensAddrs } = addresses
  if (!isRecord(coreAddrs) || !isRecord(lensAddrs)) return false

  return REQUIRED_CORE_ADDRS.every(key => isEvmAddress(coreAddrs[key]))
    && REQUIRED_LENS_ADDRS.every(key => isEvmAddress(lensAddrs[key]))
}

/** Returns the admitted (valid) entries, or throws when the payload is unusable. */
function admitDeploymentManifest(data: unknown): unknown[] {
  if (!Array.isArray(data) || data.length === 0) {
    throw new Error('Upstream returned an invalid deployment manifest')
  }

  const valid: unknown[] = []
  const dropped: (number | 'unknown')[] = []
  for (const entry of data) {
    if (isValidDeployment(entry)) valid.push(entry)
    else dropped.push(readChainId(entry) ?? 'unknown')
  }

  const validChainIds = new Set(valid.map(entry => readChainId(entry)))
  const unusableEnabledChains = getEnabledChainIds().filter(id => !validChainIds.has(id))
  if (unusableEnabledChains.length > 0) {
    throw new Error(
      `Upstream manifest is missing or invalid for enabled chains: ${unusableEnabledChains.join(', ')}`,
    )
  }
  if (valid.length === 0) {
    throw new Error('Upstream returned an invalid deployment manifest')
  }

  if (dropped.length > 0) {
    logger.warn(
      { ctx: 'euler-chains', dropped },
      'dropped invalid manifest entries for non-enabled chains',
    )
  }
  return valid
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
    const admitted = admitDeploymentManifest(data)
    cache.set(CACHE_KEY, admitted)
    return admitted
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
