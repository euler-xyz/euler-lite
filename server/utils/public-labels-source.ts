import { createGeoPolicySource } from './geo-policy-source'
import { createTtlCache } from './cache'
import { fetchWithTimeout, withWallClock } from './fetchWithTimeout'
import { createInFlightDedup } from './in-flight'
import { readLabelsSource, readV3LabelsSelection } from './labels-base-url'
import { getStaticLabelsBundle } from './static-labels-source'
import { logger } from './logger'
import { PublicLabelsV3Adapter } from '@eulerxyz/euler-v2-sdk/public-labels'
import {
  normalizeLabelsBundle,
  type PublicEulerLabelsData,
  type PublicLabelsBundle,
  type V3LabelsBundle,
  type PublicLabelsQuery,
  type PublicLabelsRequest,
  type PublicLabelsResponse,
} from '~/utils/public-labels'
import { readResolvedV3ApiUrl, readV3ApiKey } from '~/utils/api-url-env'

const CACHE_TTL_MS = 300_000
const REFRESH_BUDGET_MS = 30_000

const cache = createTtlCache<V3LabelsBundle>({ ttlMs: CACHE_TTL_MS, maxEntries: 64 })
const inFlight = createInFlightDedup<string, V3LabelsBundle>()

const geoSources = new Map<string, ReturnType<typeof createGeoPolicySource>>()
const getGeoSource = () => {
  const source = readResolvedV3ApiUrl()
  let loader = geoSources.get(source)
  if (!loader) {
    loader = createGeoPolicySource(source, process.env.GEO_POLICY_CACHE_DIR || '.data/geo-policies')
    geoSources.set(source, loader)
  }
  return loader
}

const cacheKey = (chainId: number, labelSet: string, version: string): string =>
  JSON.stringify([readResolvedV3ApiUrl(), labelSet, chainId, version])

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
  version?: string,
): Promise<PublicLabelsBundle> {
  if (readLabelsSource() === 'static') return getStaticLabelsBundle(chainId, true)
  const selection = readV3LabelsSelection()
  const selectedVersion = version ?? selection.version
  const key = cacheKey(chainId, selection.labelSet, selectedVersion)
  return inFlight.run(key, async () => {
    try {
      const bundle = await withWallClock(
        async () => {
          const request = buildRequest()
          const adapter = new PublicLabelsV3Adapter({
            endpoint: readResolvedV3ApiUrl(),
            labelSet: selection.labelSet,
            version: selectedVersion,
            request,
          })
          const geo = await getGeoSource()(request)
          const snapshot = await adapter.fetchPublicLabelsSnapshot(chainId, selectedVersion, geo.policies)
          normalizeLabelsBundle(chainId, snapshot)
          return {
            labelSet: selection.labelSet,
            version: snapshot.version,
            geoFetchedAt: geo.fetchedAt,
            publicLabels: snapshot.publicLabels,
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
  version?: string,
): Promise<PublicLabelsBundle> {
  if (readLabelsSource() === 'static') return getStaticLabelsBundle(chainId)
  const selection = readV3LabelsSelection()
  const selectedVersion = version ?? selection.version
  const hit = cache.get(cacheKey(chainId, selection.labelSet, selectedVersion))
  return hit ? Promise.resolve(hit) : refreshPublicLabelsBundle(chainId, selectedVersion)
}

export async function getPublicEulerLabelsData(
  chainId: number,
  version?: string,
): Promise<PublicEulerLabelsData> {
  const bundle = await getPublicLabelsBundle(chainId, version)
  return normalizeLabelsBundle(chainId, bundle)
}
