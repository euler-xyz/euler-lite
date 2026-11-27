import { createGeoPolicySource } from './geo-policy-source'
import { createTtlCache } from './cache'
import { fetchWithTimeout, withWallClock } from './fetchWithTimeout'
import { createInFlightDedup } from './in-flight'
import { readLabelsSource, readV3LabelsSelection, readLabelsVaultTag, readHostedLabelImageOrigins } from './labels-base-url'
import { readServerChainPolicy } from './chain-policy'
import { loadV3ChainCatalog, peekV3ChainCatalog, requiresV3ChainCatalog } from './v3-chain-catalog'
import { getStaticLabelsBundle } from './static-labels-source'
import { logger } from './logger'
import { loadEulerChains, peekEulerChains } from '~/server/api/internal/euler-chains.get'
import { chainReadPolicyKey, getChainReadPolicy, type ChainReadPolicy, type V3ChainCatalog } from '~/utils/chain-policy'
import { PublicLabelsV3Adapter, PublicLabelsV3MetadataAdapter } from '@eulerxyz/euler-v2-sdk/public-labels'
import {
  normalizeLabelsBundle,
  type PublicEulerLabelsData,
  type PublicLabelsBundle,
  type HostedLabelsBundle,
  type PublicLabelsQuery,
  type PublicLabelsRequest,
  type PublicLabelsResponse,
  type PublicGeoPolicy,
} from '~/utils/public-labels'
import { readResolvedV3ApiUrl, readV3ApiKey } from '~/utils/api-url-env'
import { isLabelsSnapshotUsable, LABELS_MAX_STALE_MS } from '~/utils/labels-freshness'
import { resolveLabelLogo } from '~/utils/label-logo'

const CACHE_TTL_MS = 300_000
const REFRESH_BUDGET_MS = 30_000

const cache = createTtlCache<HostedLabelsBundle>({ ttlMs: CACHE_TTL_MS, maxStaleMs: LABELS_MAX_STALE_MS, maxEntries: 64 })
const inFlight = createInFlightDedup<string, HostedLabelsBundle>()

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

const cacheKey = (chainId: number, labelSet: string, version: string, metadataOnly: boolean): string =>
  JSON.stringify([readResolvedV3ApiUrl(), labelSet, chainId, version, metadataOnly])

const readPolicy = (chainId: number, manifest: readonly unknown[] | undefined, catalog?: V3ChainCatalog): ChainReadPolicy =>
  getChainReadPolicy(readServerChainPolicy(manifest, catalog), chainId)

export const createPublicLabelsRequest = (): PublicLabelsRequest => async <T>(
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
    throw new PublicLabelsRequestError(response.status, path)
  }
  return await response.json() as PublicLabelsResponse<T>
}

export class PublicLabelsRequestError extends Error {
  constructor(public readonly statusCode: number, path: string) {
    super(`Public Labels V3 returned ${statusCode} for ${path}`)
  }
}

// Cached source data is complete; deployment policy is attached on every read.
const withDeploymentConfig = (bundle: PublicLabelsBundle, chainPolicy: ChainReadPolicy): PublicLabelsBundle => {
  let configuredBundle = { ...bundle, chainPolicy }
  if (bundle.source !== 'static') {
    const allowedOrigins = readHostedLabelImageOrigins()
    const labels = bundle.publicLabels
    const logos = [
      ...labels.entities.map(entity => entity.logo),
      ...labels.products.map(product => product.logo),
      ...labels.vaults.flatMap(vault => (vault.campaigns ?? []).map(campaign => campaign.logo)),
    ]
    const usedOrigins = new Set(logos.flatMap((logo) => {
      const resolved = resolveLabelLogo(logo ?? undefined, undefined, allowedOrigins)
      return resolved ? [new URL(resolved).origin] : []
    }))
    // Do not publish a private V3 origin merely because it is configured.
    // The browser only receives origins already present in approved logo URLs.
    const logoOrigins = allowedOrigins.filter(origin => usedOrigins.has(origin))
    if (logoOrigins.length) configuredBundle = { ...bundle, chainPolicy, logoOrigins }
  }
  const vaultTag = readLabelsVaultTag()
  return vaultTag ? { ...configuredBundle, vaultTag } : configuredBundle
}

const hasUsableGeo = (bundle: HostedLabelsBundle): boolean =>
  typeof bundle.geoFetchedAt === 'number' && isLabelsSnapshotUsable(bundle.geoFetchedAt)

const withCurrentGeo = (
  bundle: HostedLabelsBundle,
  geo: { fetchedAt: number, policies: PublicGeoPolicy[] },
): HostedLabelsBundle => {
  if (bundle.source === 'v3-metadata') {
    return { ...bundle, publicLabels: { ...bundle.publicLabels, geoPolicies: geo.policies }, geoFetchedAt: geo.fetchedAt }
  }
  return { ...bundle, publicLabels: { ...bundle.publicLabels, geoPolicies: geo.policies }, geoFetchedAt: geo.fetchedAt }
}

function refreshV3PublicLabelsBundle(
  chainId: number,
  labelSet: string,
  selectedVersion: string,
  metadataOnly: boolean,
): Promise<PublicLabelsBundle> {
  const key = cacheKey(chainId, labelSet, selectedVersion, metadataOnly)
  return inFlight.run(key, async () => {
    let currentGeo: { fetchedAt: number, policies: PublicGeoPolicy[] } | undefined
    try {
      const bundle = await withWallClock(
        async () => {
          const request = createPublicLabelsRequest()
          const Adapter = metadataOnly ? PublicLabelsV3MetadataAdapter : PublicLabelsV3Adapter
          const adapter = new Adapter({
            endpoint: readResolvedV3ApiUrl(),
            labelSet,
            version: selectedVersion,
            request,
          })
          currentGeo = await getGeoSource()(request)
          const snapshot = await adapter.fetchPublicLabelsSnapshot(chainId, selectedVersion, currentGeo.policies)
          const bundle = {
            ...snapshot,
            // Keep the age of the actual V3 read when this bundle is served stale.
            sourceFetchedAt: Date.now(),
            geoFetchedAt: currentGeo.fetchedAt,
          }
          normalizeLabelsBundle(chainId, bundle)
          return bundle
        },
        REFRESH_BUDGET_MS,
        `public-labels chain=${chainId}`,
      )
      cache.set(key, bundle)
      return bundle
    }
    catch (err) {
      logger.warn({ ctx: 'public-labels-source', chainId, version: selectedVersion, err }, 'refresh failed')
      const stale = cache.getStale(key)
      if (stale) {
        // A newer geo read must never be rolled back with an older labels bundle.
        // Keep the labels source timestamp and cache lifetime unchanged.
        if (currentGeo) {
          if (currentGeo.fetchedAt < (stale.geoFetchedAt ?? 0) && hasUsableGeo(stale)) return stale
          const updated = withCurrentGeo(stale, currentGeo)
          cache.replace(key, updated)
          return updated
        }
        if (hasUsableGeo(stale)) return stale
      }
      throw err
    }
  })
}

export function refreshPublicLabelsBundle(
  chainId: number,
  version?: string,
): Promise<PublicLabelsBundle> {
  return loadPublicLabelsBundle(chainId, true, version)
}

export function getCachedPublicLabelsBundle(chainId: number, version?: string): PublicLabelsBundle | undefined {
  if (readLabelsSource() === 'static') return undefined
  // Admission and any required Euler catalog must be known before choosing a cached adapter.
  const manifest = peekEulerChains()
  const catalog = peekV3ChainCatalog()
  if (!manifest || (requiresV3ChainCatalog() && !catalog)) return undefined
  const selection = readV3LabelsSelection()
  const policy = readPolicy(chainId, manifest, catalog)
  const hit = cache.get(cacheKey(chainId, selection.labelSet, version ?? selection.version, policy.metadataOnly))
  return hit && hasUsableGeo(hit) ? withDeploymentConfig(hit, policy) : undefined
}

export async function getPublicLabelsBundle(
  chainId: number,
  version?: string,
): Promise<PublicLabelsBundle> {
  return loadPublicLabelsBundle(chainId, false, version)
}

async function loadPublicLabelsBundle(chainId: number, forceRefresh: boolean, version?: string): Promise<PublicLabelsBundle> {
  const isStatic = readLabelsSource() === 'static'
  const selection = isStatic ? undefined : readV3LabelsSelection()
  const currentPolicy = async () => {
    const [manifest, catalog] = await Promise.all([
      isStatic ? peekEulerChains() : loadEulerChains(),
      loadV3ChainCatalog(),
    ])
    return readPolicy(chainId, manifest, catalog)
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const policy = await currentPolicy()
    let bundle: PublicLabelsBundle
    if (isStatic) {
      bundle = await getStaticLabelsBundle(chainId, forceRefresh)
    }
    else {
      const selectedVersion = version ?? selection!.version
      const hit = !forceRefresh && cache.get(cacheKey(chainId, selection!.labelSet, selectedVersion, policy.metadataOnly))
      bundle = hit && hasUsableGeo(hit)
        ? hit
        : await refreshV3PublicLabelsBundle(chainId, selection!.labelSet, selectedVersion, policy.metadataOnly)
    }
    if (chainReadPolicyKey(policy) === chainReadPolicyKey(await currentPolicy())) {
      return withDeploymentConfig(bundle, policy)
    }
  }
  throw new Error('Chain policy changed during labels refresh')
}

export async function getPublicEulerLabelsData(
  chainId: number,
  version?: string,
): Promise<PublicEulerLabelsData> {
  const bundle = await getPublicLabelsBundle(chainId, version)
  return normalizeLabelsBundle(chainId, bundle)
}
