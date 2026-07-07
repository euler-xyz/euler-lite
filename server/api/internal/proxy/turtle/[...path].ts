/**
 * Server-side proxy for Turtle stream reward proofs.
 *
 * Lite calls:
 *   `/api/internal/proxy/turtle/streams/merkle_proofs?wallet=0x…&streamIds=…`
 *
 * The handler forwards to Turtle Earn (`TURTLE_EARN_API_URL`, default
 * `https://earn.turtle.xyz/v1`) while keeping the browser same-origin and
 * allowlisting only the reward proof endpoint needed for claim planning.
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
import { safeErrorLogFields, safeUrlLogFields } from '~/server/utils/observability'
import {
  createProxyCache,
  createProxyInFlight,
  forwardProxied,
} from '~/server/utils/external-proxy'
import { isAllowedTurtleProxyRequest } from '~/server/utils/rewards-proxy-allowlist'

const PROXY_PREFIX = '/api/internal/proxy/turtle/'

const DEFAULT_TURTLE_EARN_API_URL = 'https://earn.turtle.xyz/v1'

const TURTLE_EARN_API_URL_ENV_KEYS = ['TURTLE_EARN_API_URL', 'NUXT_PUBLIC_TURTLE_EARN_API_URL'] as const

const CACHE_TTL_MS = 15_000
const BROWSER_CACHE_CONTROL = 'no-store'

const cache = createProxyCache(CACHE_TTL_MS)
const inFlight = createProxyInFlight()

const rateLimiter = createRateLimiter({
  max: 300,
  windowMs: 60_000,
  label: 'turtle-proxy',
})

const stripLeadingSlash = (s: string): string => (s.startsWith('/') ? s.slice(1) : s)

const readUpstreamBase = (): string => {
  for (const key of TURTLE_EARN_API_URL_ENV_KEYS) {
    const v = process.env[key]
    if (v && v.trim()) return v.trim().replace(/\/+$/, '')
  }
  return DEFAULT_TURTLE_EARN_API_URL
}

export default defineEventHandler(async (event) => {
  const method = getMethod(event).toUpperCase()
  if (method !== 'GET' && method !== 'HEAD') {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }

  const requestUrl = getRequestURL(event)
  const idx = requestUrl.pathname.indexOf(PROXY_PREFIX)
  if (idx < 0) {
    throw createError({ statusCode: 404, statusMessage: 'Not a turtle proxy path' })
  }
  const rest = stripLeadingSlash(requestUrl.pathname.slice(idx + PROXY_PREFIX.length))
  if (!isAllowedTurtleProxyRequest(method, rest, requestUrl.searchParams)) {
    throw createError({ statusCode: 404, statusMessage: 'Turtle path not allowed' })
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
      ctx: 'turtle-proxy',
      bypassCache: true,
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
        ctx: 'turtle-proxy',
        ...safeUrlLogFields(target),
        err: safeErrorLogFields(err),
      },
      'upstream failed',
    )
    throw createError({ statusCode: 502, statusMessage: 'Turtle upstream unavailable' })
  }
})
