/**
 * Factory for the same-origin provider proxies under `/api/internal/proxy/*`.
 *
 * Every provider route used to hand-roll the same pipeline: method check,
 * prefix parse, allowlist, rate limit, upstream headers, forward through
 * `forwardProxied`, map failures to 502/504, set browser cache headers. That
 * duplication is where behaviour drifted (one route skipped the shared
 * forwarder, redirect policy had to be audited route by route). The factory
 * owns the pipeline; a route file is now a config object.
 *
 * Per-provider concerns stay in config: upstream, allowlist, credential
 * headers, rate limit, cache TTL and browser hint, redirect policy.
 *
 * Pipeline order, and the status each step answers with:
 *   1. method not in `methods`            → 405
 *   2. path does not contain `prefix`     → 404
 *   3. `allow()` rejects path/query       → 404 (before any upstream contact)
 *   4. rate limit                          → 429 / 403 (see `rate-limit.ts`)
 *   5. `headers()` returns `undefined`    → 503 (required credential missing)
 *   6. upstream timeout                    → 504
 *   7. upstream non-2xx / network error   → 502 (stale cache served first when available)
 *
 * Caller headers are never forwarded. Upstream error bodies are never
 * returned or logged; only host, path template, query keys and status are.
 */
import type { H3Event } from 'h3'
import {
  createError,
  getMethod,
  getRequestURL,
  readRawBody,
  setResponseHeaders,
  setResponseStatus,
} from 'h3'
import { createRateLimiter } from './rate-limit'
import { logger } from './logger'
import { safeErrorLogFields, safePathTemplate, safeUrlLogFields, searchKeys } from './observability'
import { createProxyCache, createProxyInFlight, forwardProxied } from './external-proxy'
import { isAbortError } from '~/utils/errorHandling'

export interface ProviderProxyConfig {
  /** Provider name for error messages, e.g. `Merkl`. */
  name: string
  /** Log context and rate-limiter label, e.g. `merkl-proxy`. */
  ctx: string
  /** Route prefix with trailing slash, e.g. `/api/internal/proxy/merkl/`. */
  prefix: string
  /**
   * Upstream base without trailing slash. Pass a function when the value
   * comes from env so overrides are re-read per request.
   */
  upstream: string | (() => string)
  /** Accepted HTTP methods. Anything else is 405. */
  methods: readonly string[]
  /** Path + query allowlist. `false` is a 404 before any upstream contact. */
  allow: (method: string, path: string, params: URLSearchParams) => boolean
  /**
   * Upstream request headers. Return `undefined` to fail closed with 503 when
   * a required credential is missing. Defaults to `{ accept: 'application/json' }`.
   */
  headers?: () => Record<string, string> | undefined
  rateLimit: { max: number, windowMs: number }
  cache: {
    /** Server-side TTL. Ignored when `bypass` is set. */
    ttlMs: number
    /** `cache-control` value sent to the browser. */
    browser: string
    /**
     * Skip the server TTL cache: per-wallet reads where a stale body would
     * mask just-confirmed state. In-flight dedup still coalesces concurrent
     * identical requests.
     */
    bypass?: boolean
  }
  /** Mutate the upstream URL before forwarding, e.g. to default a query param. */
  rewriteTarget?: (target: URL, rest: string) => void
  /**
   * Fetch redirect policy. Proxies that attach a credential pass `'manual'`
   * so a redirect surfaces as a 502 instead of replaying the credential
   * against whatever host the redirect names.
   */
  redirect?: RequestRedirect
  /** Forward the raw request body upstream (POST proxies). */
  forwardBody?: boolean
}

export type ProviderProxyHandler = (event: H3Event) => Promise<string>

const DEFAULT_HEADERS: Record<string, string> = { accept: 'application/json' }

const stripLeadingSlash = (s: string): string => (s.startsWith('/') ? s.slice(1) : s)

/**
 * Upstream resolver for anonymous providers whose base URL may be overridden
 * from env: first non-empty value among `keys` (trailing slashes stripped),
 * else `fallback`. Credentialed providers should use a constant instead.
 */
export const upstreamFromEnv = (keys: readonly string[], fallback: string) => (): string => {
  for (const key of keys) {
    const value = process.env[key]?.trim()
    if (value) return value.replace(/\/+$/, '')
  }
  return fallback
}

const buildTarget = (
  base: string,
  rest: string,
  requestUrl: URL,
  rewrite: ProviderProxyConfig['rewriteTarget'],
): string => {
  const raw = `${base}/${rest}${requestUrl.search}`
  if (!rewrite) return raw
  const url = new URL(raw)
  rewrite(url, rest)
  return url.toString()
}

const targetLogFields = (target: string) => {
  let pathTemplate: string | undefined
  try {
    pathTemplate = safePathTemplate(new URL(target).pathname)
  }
  catch {
    pathTemplate = undefined
  }
  return { ...safeUrlLogFields(target), ...(pathTemplate ? { pathTemplate } : {}) }
}

export function createProviderProxy(config: ProviderProxyConfig): ProviderProxyHandler {
  const { name, ctx, prefix } = config
  const slug = name.toLowerCase()
  const methods = new Set(config.methods.map(m => m.toUpperCase()))
  const cache = createProxyCache(config.cache.bypass ? 0 : config.cache.ttlMs)
  const inFlight = createProxyInFlight()
  const rateLimiter = createRateLimiter({ ...config.rateLimit, label: ctx })
  const upstream = config.upstream
  const resolveUpstream = typeof upstream === 'string' ? () => upstream : upstream
  const buildHeaders = config.headers ?? (() => DEFAULT_HEADERS)

  return async (event) => {
    const method = getMethod(event).toUpperCase()
    if (!methods.has(method)) {
      logger.warn({ ctx, method, reason: 'invalid-method' }, 'request rejected')
      throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
    }

    const requestUrl = getRequestURL(event)
    const idx = requestUrl.pathname.indexOf(prefix)
    if (idx < 0) {
      logger.warn({ ctx, method, reason: 'invalid-path' }, 'request rejected')
      throw createError({ statusCode: 404, statusMessage: `Not a ${slug} proxy path` })
    }
    const rest = stripLeadingSlash(requestUrl.pathname.slice(idx + prefix.length))
    if (!config.allow(method, rest, requestUrl.searchParams)) {
      logger.warn(
        {
          ctx,
          method,
          reason: 'path-not-allowed',
          pathTemplate: safePathTemplate(`/${rest}`),
          searchKeys: searchKeys(requestUrl.searchParams),
        },
        'request rejected',
      )
      throw createError({ statusCode: 404, statusMessage: `${name} path not allowed` })
    }

    await rateLimiter.consume(event)

    const headers = buildHeaders()
    if (!headers) {
      logger.warn({ ctx, reason: 'missing-api-key' }, 'request rejected')
      throw createError({ statusCode: 503, statusMessage: `${name} API key not configured` })
    }

    const target = buildTarget(resolveUpstream(), rest, requestUrl, config.rewriteTarget)
    const body = config.forwardBody ? (await readRawBody(event))?.toString() : undefined
    const startedAt = Date.now()

    try {
      const res = await forwardProxied({
        cache,
        inFlight,
        method,
        target,
        headers: body ? { ...headers, 'content-type': 'application/json' } : headers,
        body,
        ctx,
        ...(config.cache.bypass ? { bypassCache: true } : {}),
        ...(config.redirect ? { redirect: config.redirect } : {}),
      })
      setResponseStatus(event, res.status, res.statusText)
      setResponseHeaders(event, {
        'content-type': res.contentType,
        'cache-control': config.cache.browser,
        'x-cache': res.cacheState,
      })
      return res.body
    }
    catch (err) {
      const durationMs = Date.now() - startedAt
      if (isAbortError(err)) {
        logger.info({ ctx, ...targetLogFields(target), durationMs, reason: 'upstream-timeout' }, 'upstream timed out')
        throw createError({ statusCode: 504, statusMessage: `${name} upstream timed out` })
      }
      logger.warn(
        {
          ctx,
          ...targetLogFields(target),
          durationMs,
          ...(body ? { bodyBytes: body.length } : {}),
          err: safeErrorLogFields(err),
        },
        'upstream failed',
      )
      throw createError({ statusCode: 502, statusMessage: `${name} upstream unavailable` })
    }
  }
}
