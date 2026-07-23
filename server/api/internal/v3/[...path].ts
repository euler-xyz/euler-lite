import {
  createError,
  getMethod,
  getRequestURL,
  readRawBody,
  setResponseHeader,
  setResponseHeaders,
  setResponseStatus,
} from 'h3'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { logger } from '~/server/utils/logger'
import { safePathTemplate, urlHost } from '~/server/utils/observability'
import { createRateLimiter } from '~/server/utils/rate-limit'
import {
  buildV3ProxyBackoffKey,
  readV3ProxyBackoffMs,
  recordV3ProxyBackoff,
  updateV3ProxyBackoffFromResponse,
  V3_PROXY_FAILURE_BACKOFF_MS,
} from '~/server/utils/v3-proxy-backoff'
import {
  buildV3ProxyRequestHeaders,
  buildV3ProxyTarget,
  buildV3ProxyLogFields,
  getV3ProxyPath,
  readForwardedV3ResponseHeaders,
  validateV3ProxyUrl,
} from '~/server/utils/v3-proxy'
import { isAbortError } from '~/utils/errorHandling'

const ALLOWED_METHODS = new Set(['GET', 'POST'])

const rateLimiter = createRateLimiter({
  max: 10_000,
  windowMs: 60_000,
  label: 'v3-proxy',
})

export default defineEventHandler(async (event) => {
  const method = getMethod(event).toUpperCase()
  if (!ALLOWED_METHODS.has(method)) {
    logger.warn({ ctx: 'v3-proxy', method, reason: 'invalid-method' }, 'request rejected')
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }

  const requestUrl = getRequestURL(event)
  const proxyPath = getV3ProxyPath(requestUrl)
  const pathTemplate = safePathTemplate(proxyPath)
  const logFields = buildV3ProxyLogFields(requestUrl)
  const urlValidation = validateV3ProxyUrl(method, requestUrl)
  if (urlValidation.ok === false) {
    logger.warn(
      { ctx: 'v3-proxy', method, pathTemplate, reason: urlValidation.statusMessage, statusCode: urlValidation.statusCode },
      'request rejected',
    )
    throw createError({ statusCode: urlValidation.statusCode, statusMessage: urlValidation.statusMessage })
  }
  rateLimiter.consume(event, method === 'POST' ? 5 : 1)

  const target = buildV3ProxyTarget(requestUrl)
  const backoffKey = buildV3ProxyBackoffKey(method, proxyPath, requestUrl.searchParams)
  const backoffMs = readV3ProxyBackoffMs(backoffKey)
  if (backoffMs > 0) {
    setResponseHeader(event, 'retry-after', Math.ceil(backoffMs / 1_000))
    throw createError({ statusCode: 503, statusMessage: 'V3 upstream cooling down' })
  }

  const headers = buildV3ProxyRequestHeaders(method)
  const body = method === 'POST' ? await readRawBody(event) : undefined
  const startedAt = Date.now()
  const upstreamHost = urlHost(target)

  let upstream: Response
  try {
    upstream = await fetchWithTimeout(target, undefined, {
      method,
      headers,
      body,
    })
  }
  catch (err) {
    const timedOut = isAbortError(err)
    logger.warn(
      {
        ctx: 'v3-proxy',
        method,
        pathTemplate,
        ...logFields,
        upstreamHost,
        bodyBytes: body?.length,
        durationMs: Date.now() - startedAt,
        reason: timedOut ? 'upstream-timeout' : 'upstream-error',
        ...(!timedOut ? { err } : {}),
      },
      timedOut ? 'upstream timed out' : 'upstream fetch failed',
    )
    recordV3ProxyBackoff(backoffKey)
    setResponseHeader(event, 'retry-after', Math.ceil(V3_PROXY_FAILURE_BACKOFF_MS / 1_000))
    throw createError({ statusCode: 503, statusMessage: 'V3 upstream unavailable' })
  }

  updateV3ProxyBackoffFromResponse(backoffKey, upstream.status)
  if ([429, 500, 502, 503, 504].includes(upstream.status)) {
    setResponseHeader(event, 'retry-after', Math.ceil(V3_PROXY_FAILURE_BACKOFF_MS / 1_000))
  }

  setResponseStatus(event, upstream.status, upstream.statusText)
  setResponseHeaders(event, readForwardedV3ResponseHeaders(upstream.headers))

  if (upstream.status === 204 || upstream.status === 304) {
    return undefined
  }

  const text = await upstream.text()
  if (!upstream.ok) {
    logger.warn(
      {
        ctx: 'v3-proxy',
        method,
        pathTemplate,
        ...logFields,
        upstreamHost,
        bodyBytes: body?.length,
        status: upstream.status,
        durationMs: Date.now() - startedAt,
      },
      'upstream returned non-ok status',
    )
  }
  return text
})
