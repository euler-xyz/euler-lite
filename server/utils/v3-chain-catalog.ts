import { createTtlCache } from './cache'
import { withWallClock } from './fetchWithTimeout'
import { createInFlightDedup } from './in-flight'
import { readLabelsSource } from './labels-base-url'
import { logger } from './logger'
import { DEFAULT_V3_API_URL, isV3BackendEnabled, readBrowserVaultSource, readDisableV3, readResolvedV3ApiUrl, readServerVaultCacheSource, readV3ApiKey } from '~/utils/api-url-env'
import type { V3ChainCatalog } from '~/utils/chain-policy'

const CACHE_TTL_MS = 5 * 60_000
const MAX_AGE_MS = 24 * 60 * 60_000
const REQUEST_BUDGET_MS = 10_000
const cache = createTtlCache<V3ChainCatalog>({ ttlMs: CACHE_TTL_MS, maxStaleMs: MAX_AGE_MS - CACHE_TTL_MS, maxEntries: 8 })
const failures = createTtlCache<true>({ ttlMs: 30_000, maxStaleMs: 0, maxEntries: 8 })
const inFlight = createInFlightDedup<string, V3ChainCatalog>()

export class V3ChainCatalogUnavailableError extends Error {
  readonly statusCode = 503

  constructor() {
    super('V3 chain catalog unavailable')
  }
}

/** Custom backends retain configured routing without implementing Euler's catalog. */
export const requiresV3ChainCatalog = (): boolean =>
  !readDisableV3()
  && URL.parse(readResolvedV3ApiUrl())?.href === new URL(DEFAULT_V3_API_URL).href
  && (readLabelsSource() === 'v3' || isV3BackendEnabled()
    || readBrowserVaultSource() === 'v3' || readServerVaultCacheSource() === 'v3')

const source = () => {
  const url = new URL(readResolvedV3ApiUrl())
  const basePath = url.pathname.replace(/\/+$/, '')
  url.pathname = `${basePath.endsWith('/v3') ? basePath : `${basePath}/v3`}/chains`
  const apiKey = readV3ApiKey().trim()
  return { url: url.toString(), apiKey, key: JSON.stringify([url.toString(), apiKey]) }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value)

/** Missing rows mean unsupported only in a complete, validated catalog response. */
const parseCatalog = (payload: unknown): V3ChainCatalog => {
  if (!isRecord(payload) || !Array.isArray(payload.data)) throw new Error('Invalid V3 chain catalog')
  const meta = payload.meta
  if (meta !== undefined && (!isRecord(meta)
    || (meta.total !== undefined && meta.total !== payload.data.length)
    || (meta.offset !== undefined && meta.offset !== 0)
    || (meta.hasMore !== undefined && meta.hasMore !== false)
    || (meta.nextCursor !== undefined && meta.nextCursor !== null))) {
    throw new Error('Incomplete V3 chain catalog')
  }
  const ids = new Set<number>()
  const indexedChainIds: number[] = []
  for (const row of payload.data) {
    if (!isRecord(row) || typeof row.id !== 'number' || !Number.isSafeInteger(row.id) || row.id <= 0
      || ids.has(row.id) || !Array.isArray(row.capabilities)
      || !row.capabilities.every(capability => typeof capability === 'string' && capability.length > 0)) {
      throw new Error('Invalid V3 chain catalog row')
    }
    ids.add(row.id)
    if (row.capabilities.includes('indexing')) indexedChainIds.push(row.id)
  }
  return { indexedChainIds: indexedChainIds.sort((a, b) => a - b) }
}

/** Synchronous seed for HTML and cache selection; never fetches or invents support. */
export const peekV3ChainCatalog = (): V3ChainCatalog | undefined =>
  requiresV3ChainCatalog() ? cache.getStale(source().key) : undefined

export const loadV3ChainCatalog = async (): Promise<V3ChainCatalog | undefined> => {
  if (!requiresV3ChainCatalog()) return undefined
  const { url, apiKey, key } = source()
  const fresh = cache.get(key)
  if (fresh) return fresh
  const staleOrThrow = () => {
    const stale = cache.getStale(key)
    if (stale) return stale
    throw new V3ChainCatalogUnavailableError()
  }
  if (failures.get(key)) return staleOrThrow()
  return inFlight.run(key, async () => {
    const controller = new AbortController()
    try {
      const catalog = await withWallClock(async () => {
        const response = await fetch(url, {
          signal: controller.signal,
          headers: { accept: 'application/json', ...(apiKey ? { 'X-API-Key': apiKey } : {}) },
          redirect: 'error',
        })
        if (!response.ok) throw new Error(`V3 chain catalog returned ${response.status}`)
        return parseCatalog(await response.json())
      }, REQUEST_BUDGET_MS, 'V3 chain catalog')
      cache.set(key, catalog)
      return catalog
    }
    catch {
      // Upstream URLs and API keys never enter the public error or log message.
      logger.warn({ ctx: 'v3-chain-catalog' }, 'catalog refresh failed; retaining bounded last-known support')
      failures.set(key, true)
      return staleOrThrow()
    }
    finally {
      // The deadline covers headers and body; abort also releases a stalled body read.
      controller.abort()
    }
  })
}
