import { createTtlCache } from './cache'
import { fetchWithTimeout, withWallClock } from './fetchWithTimeout'
import { createInFlightDedup } from './in-flight'
import { getEffectiveLabelsSource } from './labels-source'
import { logger } from './logger'
import {
  fetchPublicLabelsSource,
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

interface PublishedLabelVersion {
  versionKey?: string
  status?: string
  aliases?: string[]
  isLatest?: boolean
}

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

const resolveVersion = async (
  request: PublicLabelsRequest,
  requestedVersion: string,
): Promise<string> => {
  if (requestedVersion !== PUBLIC_LABELS_RUNTIME_VERSION) return requestedVersion
  const response = await request<PublishedLabelVersion[]>('/label-sets/public/versions', {})
  if (!Array.isArray(response.data)) throw new Error('Invalid Public Labels versions response')
  const published = response.data.find(version =>
    version.status === 'published'
    && (version.isLatest === true || version.aliases?.includes(PUBLIC_LABELS_RUNTIME_VERSION)),
  )
  if (!published?.versionKey || !/^v[0-9]{17}$/.test(published.versionKey)) {
    throw new Error('Public Labels latest alias is unavailable')
  }
  return published.versionKey
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
          const resolvedVersion = await resolveVersion(request, version)
          const [publicLabels, effectivePolicy] = await Promise.all([
            fetchPublicLabelsSource(request, chainId, resolvedVersion),
            getEffectiveLabelsSource(chainId),
          ])
          // Validate the complete cross-source relationship before replacing
          // a known-good raw bundle. Server consumers normalize it again into
          // SDK-compatible Sets/RegExps; the browser receives JSON-safe data.
          normalizePublicLabelsData(chainId, publicLabels, effectivePolicy)
          return { version: resolvedVersion, publicLabels, effectivePolicy }
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
