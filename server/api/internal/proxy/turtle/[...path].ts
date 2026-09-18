/**
 * Server-side proxy for Turtle stream reward proofs.
 *
 * Lite calls:
 *   `/api/internal/proxy/turtle/streams/merkle_proofs?wallet=0x…&streamIds=…`
 *
 * The handler forwards to Turtle Earn (`https://earn.turtle.xyz/v1`, a
 * constant — see `turtle-proxy.ts`) while keeping the browser same-origin and
 * allowlisting only the reward proof endpoint needed for claim planning.
 *
 * Turtle requires an API key on every request. The server-only
 * `TURTLE_EARN_API_KEY` is attached as `X-API-Key` here and nowhere else:
 * caller headers are never forwarded, the key is never logged, and when it is
 * missing the route answers 503 without contacting upstream. Redirects are
 * not followed so the key cannot be replayed against another host.
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
import { TURTLE_EARN_API_URL, buildTurtleProxyRequestHeaders } from '~/server/utils/turtle-proxy'

const PROXY_PREFIX = '/api/internal/proxy/turtle/'

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

  await rateLimiter.consume(event)

  const headers = buildTurtleProxyRequestHeaders()
  if (!headers) {
    logger.warn({ ctx: 'turtle-proxy', reason: 'missing-api-key' }, 'request rejected')
    throw createError({ statusCode: 503, statusMessage: 'Turtle API key not configured' })
  }

  const target = `${TURTLE_EARN_API_URL}/${rest}${requestUrl.search}`

  try {
    const res = await forwardProxied({
      cache,
      inFlight,
      method,
      target,
      headers,
      ctx: 'turtle-proxy',
      bypassCache: true,
      redirect: 'manual',
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
