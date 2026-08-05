import { createTtlCache } from './cache'
import { fetchWithTimeout, withWallClock } from './fetchWithTimeout'
import { createInFlightDedup } from './in-flight'
import { getEffectiveLabelsSource } from './labels-source'
import { logger } from './logger'
import { PublicLabelsV3Adapter } from '@eulerxyz/euler-v2-sdk/public-labels'
import {
  normalizePublicLabelsData,
  PUBLIC_LABELS_RUNTIME_VERSION,
  type PublicEulerLabelsData,
  type PublicLabelsBundle,
  type PublicLabelsQuery,
  type PublicLabelsRequest,
  type PublicLabelsResponse,
} from '~/utils/public-labels'
import { readResolvedV3ApiUrl, readV3ApiKey } from '~/utils/api-url-env'

const CACHE_TTL_MS = 300_000
const REFRESH_BUDGET_MS = 30_000

const cache = createTtlCache<PublicLabelsBundle>({ ttlMs: CACHE_TTL_MS, maxEntries: 64 })
const inFlight = createInFlightDedup<string, PublicLabelsBundle>()

const cacheKey = (chainId: number, version: string): string => `${chainId}:${version}`

const buildRequest = (): PublicLabelsRequest => async <T>(
  path: string,
  query: PublicLabelsQuery,
): Promise<PublicLabelsResponse<T>> => {
  const base = new URL(readResolvedV3ApiUrl())
  const basePath = base.pathname.replace(/\/+$/, '')
  base.pathname = `${basePath.endsWith('/v3') ? basePath : `${basePath}/v3`}${path}`
  for (const [key, value] of Object.entries(query)) {
    if (value !== undefined) base.searchParams.set(key, String(value))
  }

  const headers = new Headers({ accept: 'application/json' })
  const apiKey = readV3ApiKey().trim()
  if (apiKey) headers.set('X-API-Key', apiKey)

  const response = await fetchWithTimeout(base.toString(), undefined, { headers })
  if (!response.ok) {
    throw new Error(`Public Labels V3 returned ${response.status} for ${path}`)
  }
  return await response.json() as PublicLabelsResponse<T>
}

export function refreshPublicLabelsBundle(
  chainId: number,
  version = PUBLIC_LABELS_RUNTIME_VERSION,
): Promise<PublicLabelsBundle> {
  const key = cacheKey(chainId, version)
  return inFlight.run(key, async () => {
    try {
      const bundle = await withWallClock(
        async () => {
          const request = buildRequest()
          const adapter = new PublicLabelsV3Adapter({
            endpoint: readResolvedV3ApiUrl(),
            request,
          })
          const [snapshot, effectivePolicy] = await Promise.all([
            adapter.fetchPublicLabelsSnapshot(chainId, version),
            getEffectiveLabelsSource(chainId),
          ])
          // Validate the complete cross-source relationship before replacing
          // a known-good raw bundle. Server consumers normalize it again into
          // SDK-compatible Sets/RegExps; the browser receives JSON-safe data.
          normalizePublicLabelsData(chainId, snapshot.publicLabels, effectivePolicy)
          return {
            version: snapshot.version,
            publicLabels: snapshot.publicLabels,
            effectivePolicy,
          }
        },
        REFRESH_BUDGET_MS,
        `public-labels chain=${chainId}`,
      )
      cache.set(key, bundle)
      return bundle
    }
    catch (err) {
      logger.warn({ ctx: 'public-labels-source', chainId, version, err }, 'refresh failed')
      const stale = cache.getStale(key)
      if (stale) return stale
      throw err
    }
  })
}

export function getPublicLabelsBundle(
  chainId: number,
  version = PUBLIC_LABELS_RUNTIME_VERSION,
): Promise<PublicLabelsBundle> {
  const hit = cache.get(cacheKey(chainId, version))
  return hit ? Promise.resolve(hit) : refreshPublicLabelsBundle(chainId, version)
}

export async function getPublicEulerLabelsData(
  chainId: number,
  version = PUBLIC_LABELS_RUNTIME_VERSION,
): Promise<PublicEulerLabelsData> {
  const bundle = await getPublicLabelsBundle(chainId, version)
  return normalizePublicLabelsData(chainId, bundle.publicLabels, bundle.effectivePolicy)
}
