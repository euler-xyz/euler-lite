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

const cache = createTtlCache<unknown>({
  ttlMs: CACHE_TTL_MS,
  maxStaleMs: MANIFEST_MAX_STALE_MS,
})
let cachedChainIds = new Set<number>()
let refreshedAt: number | undefined
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

// Admission is per chain. Valid rows refresh independently; invalid rows may
// retain their last-good entry within its original stale window. Missing rows
// leave the admitted set. A wholly unusable response cannot replace that set.
// Only core/lens keys needed by SDK builds and lend/borrow are required, so
// missing peripheral keys degrade a feature rather than excluding the chain.
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

  if (valid.length === 0) {
    throw new Error('Upstream returned an invalid deployment manifest')
  }

  if (dropped.length > 0) {
    logger.warn(
      { ctx: 'euler-chains', dropped },
      'ignoring invalid manifest entries; cached entries retain their original stale deadline',
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
    const previousChainIds = cachedChainIds
    cachedChainIds = new Set<number>()
    for (const entry of admitted) {
      const chainId = readChainId(entry)!
      cache.set(String(chainId), entry)
      cachedChainIds.add(chainId)
    }
    // Keep bounded fallback only for rows still present in this response.
    // An omitted chain is removed, including from the browser enabled set.
    for (const entry of data as unknown[]) {
      const chainId = readChainId(entry)
      if (chainId !== undefined && previousChainIds.has(chainId)) cachedChainIds.add(chainId)
    }
    refreshedAt = Date.now()
    return peekEulerChains()!
  })
}

/** The cached manifest, fresh or within the stale window, without fetching. */
export function peekEulerChains(): unknown[] | undefined {
  const entries: unknown[] = []
  for (const chainId of cachedChainIds) {
    const entry = cache.getStale(String(chainId))
    if (entry) entries.push(entry)
    else cachedChainIds.delete(chainId)
  }
  return entries.length ? entries : undefined
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
  const cached = peekEulerChains()
  if (cached && refreshedAt !== undefined && Date.now() - refreshedAt < CACHE_TTL_MS) return cached

  try {
    return await refreshEulerChains()
  }
  catch (err) {
    logger.warn({ ctx: 'euler-chains', err }, 'upstream fetch failed')

    const stale = peekEulerChains()
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
