/**
 * Shared helper for proxy handlers that forward a request to an external
 * upstream, with TTL caching, in-flight dedup, and stale fallback.
 *
 * Three responsibilities live here so each per-host proxy can stay tiny:
 *   1. compose the request to upstream (method, headers, body)
 *   2. cache the response in-process keyed by (method + target + body hash)
 *   3. log + classify upstream failures uniformly
 *
 * Per-host concerns — allowlists, rate limits, cache TTL, browser
 * Cache-Control — stay in the per-host handler.
 */
import { createHash } from 'node:crypto'
import { fetchWithTimeout } from './fetchWithTimeout'
import { createTtlCache } from './cache'
import { createInFlightDedup, type InFlightDedup } from '~/utils/in-flight'
import { logger } from './logger'

export interface ExternalProxyCache {
  get: (key: string) => string | undefined
  getStale: (key: string) => string | undefined
  set: (key: string, value: string) => void
}

export interface ProxyForwardArgs {
  cache: ExternalProxyCache
  inFlight: InFlightDedup<string, string>
  method: string
  target: string
  headers: Record<string, string>
  body?: string
  ctx: string
}

export interface ProxyForwardResult {
  status: number
  statusText: string
  contentType: string
  body: string
  cacheState: 'hit' | 'miss' | 'stale-fallback'
}

export function buildCacheKey(method: string, target: string, body?: string): string {
  const h = createHash('sha1')
  h.update(method.toUpperCase())
  h.update('\0')
  h.update(target)
  if (body) {
    h.update('\0')
    h.update(body)
  }
  return h.digest('hex')
}

export function createProxyCache(ttlMs: number) {
  const ttl = createTtlCache<string>({ ttlMs })
  return {
    get: (k: string) => ttl.get(k),
    getStale: (k: string) => ttl.getStale(k),
    set: (k: string, v: string) => ttl.set(k, v),
  }
}

export function createProxyInFlight(): InFlightDedup<string, string> {
  return createInFlightDedup<string, string>()
}

export async function forwardProxied(args: ProxyForwardArgs): Promise<ProxyForwardResult> {
  const { cache, inFlight, method, target, headers, body, ctx } = args
  const cacheKey = buildCacheKey(method, target, body)

  const cached = cache.get(cacheKey)
  if (cached !== undefined) {
    return { status: 200, statusText: 'OK', contentType: 'application/json', body: cached, cacheState: 'hit' }
  }

  try {
    const fresh: string = await inFlight.run(cacheKey, async () => {
      const upstream = await fetchWithTimeout(target, undefined, {
        method,
        headers,
        body: body ?? undefined,
      })
      if (!upstream.ok) {
        const text = await upstream.text().catch(() => '')
        const err = new Error(`upstream ${upstream.status}: ${text.slice(0, 200)}`)
        ;(err as Error & { status?: number }).status = upstream.status
        throw err
      }
      const text = await upstream.text()
      cache.set(cacheKey, text)
      return text
    })
    return { status: 200, statusText: 'OK', contentType: 'application/json', body: fresh, cacheState: 'miss' }
  }
  catch (err) {
    const stale = cache.getStale(cacheKey)
    if (stale !== undefined) {
      logger.warn({ ctx, target, err: (err as Error).message }, 'serving stale on upstream failure')
      return { status: 200, statusText: 'OK (stale)', contentType: 'application/json', body: stale, cacheState: 'stale-fallback' }
    }
    throw err
  }
}
