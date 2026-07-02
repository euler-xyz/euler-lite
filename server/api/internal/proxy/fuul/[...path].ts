/**
 * Server-side proxy for Fuul's rewards API.
 *
 * The SDK's rewardsDirectAdapter constructs URLs like
 *   `${fuulApiUrl}/incentives?protocol=euler&chain_id=1`
 *   `${fuulApiUrl}/claimable-rewards?protocol=euler&user_address=0x…&chain_id=1`
 *
 * Point the SDK at `/api/internal/proxy/fuul` and this handler rewrites to the real
 * upstream (`FUUL_API_URL`, default `https://api.fuul.xyz/api/v1`).
 * TTL-cached server-side for cross-tab sharing.
 */
import {
  createError,
  getMethod,
  getRequestURL,
  setResponseHeaders,
  setResponseStatus,
} from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { logger } from '~/server/utils/logger'
import { safeErrorLogFields, safePathTemplate, safeUrlLogFields, searchKeys } from '~/server/utils/observability'
import {
  createProxyCache,
  createProxyInFlight,
  forwardProxied,
} from '~/server/utils/external-proxy'
import { isAllowedFuulProxyRequest } from '~/server/utils/rewards-proxy-allowlist'

const PROXY_PREFIX = '/api/internal/proxy/fuul/'

const DEFAULT_FUUL_API_URL = 'https://api.fuul.xyz/api/v1'

const FUUL_API_URL_ENV_KEYS = ['FUUL_API_URL', 'NUXT_PUBLIC_FUUL_API_URL'] as const

const CACHE_TTL_MS = 60_000
const BROWSER_CACHE_CONTROL = 'public, max-age=30, stale-while-revalidate=30'

const cache = createProxyCache(CACHE_TTL_MS)
const inFlight = createProxyInFlight()

const rateLimiter = createRateLimiter({
  max: 600,
  windowMs: 60_000,
  label: 'fuul-proxy',
})

const stripLeadingSlash = (s: string): string => (s.startsWith('/') ? s.slice(1) : s)

const readUpstreamBase = (): string => {
  for (const key of FUUL_API_URL_ENV_KEYS) {
    const v = process.env[key]
    if (v && v.trim()) return v.trim().replace(/\/+$/, '')
  }
  return DEFAULT_FUUL_API_URL
}

export default defineEventHandler(async (event) => {
  const method = getMethod(event).toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    logger.warn({ ctx: 'fuul-proxy', method, reason: 'invalid-method' }, 'request rejected')
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }

  const requestUrl = getRequestURL(event)
  const idx = requestUrl.pathname.indexOf(PROXY_PREFIX)
  if (idx < 0) {
    logger.warn({ ctx: 'fuul-proxy', method, reason: 'invalid-path' }, 'request rejected')
    throw createError({ statusCode: 404, statusMessage: 'Not a fuul proxy path' })
  }
  const rest = stripLeadingSlash(requestUrl.pathname.slice(idx + PROXY_PREFIX.length))
  if (!isAllowedFuulProxyRequest(method, rest, requestUrl.searchParams)) {
    logger.warn(
      {
        ctx: 'fuul-proxy',
        method,
        reason: 'path-not-allowed',
        pathTemplate: safePathTemplate(`/${rest}`),
        searchKeys: searchKeys(requestUrl.searchParams),
      },
      'request rejected',
    )
    throw createError({ statusCode: 404, statusMessage: 'Fuul path not allowed' })
  }

  const target = `${readUpstreamBase()}/${rest}${requestUrl.search}`
  await rateLimiter.consume(event)

  try {
    const res = await forwardProxied({
      cache,
      inFlight,
      method,
      target,
      headers: { accept: 'application/json' },
      ctx: 'fuul-proxy',
    })
    setResponseStatus(event, res.status, res.statusText)
    setResponseHeaders(event, {
      'content-type': res.contentType,
      'cache-control': BROWSER_CACHE_CONTROL,
      'x-cache': res.cacheState,
    })
    return res.body
  }
  catch (err) {
    logger.warn(
      {
        ctx: 'fuul-proxy',
        ...safeUrlLogFields(target),
        err: safeErrorLogFields(err),
      },
      'upstream failed',
    )
    throw createError({ statusCode: 502, statusMessage: 'Fuul upstream unavailable' })
  }
})
