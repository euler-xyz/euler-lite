import {
  createError,
  getMethod,
  getRequestURL,
  readRawBody,
  setResponseHeaders,
  setResponseStatus,
} from 'h3'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { logger } from '~/server/utils/logger'
import { safePathTemplate, urlHost } from '~/server/utils/observability'
import { createRateLimiter } from '~/server/utils/rate-limit'
import {
  buildV3ProxyRequestHeaders,
  buildV3ProxyTarget,
  getV3ProxyPath,
  readForwardedV3ResponseHeaders,
  validateV3ProxyUrl,
} from '~/server/utils/v3-proxy'

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
  const pathTemplate = safePathTemplate(getV3ProxyPath(requestUrl))
  const urlValidation = validateV3ProxyUrl(method, requestUrl)
  if (!urlValidation.ok) {
    logger.warn(
      { ctx: 'v3-proxy', method, pathTemplate, reason: urlValidation.statusMessage, statusCode: urlValidation.statusCode },
      'request rejected',
    )
    throw createError({ statusCode: urlValidation.statusCode, statusMessage: urlValidation.statusMessage })
  }
  rateLimiter.consume(event, method === 'POST' ? 5 : 1)

  const target = buildV3ProxyTarget(requestUrl)
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
    logger.warn(
      {
        ctx: 'v3-proxy',
        method,
        pathTemplate,
        upstreamHost,
        bodyBytes: body?.length,
        durationMs: Date.now() - startedAt,
        err,
      },
      'upstream fetch failed',
    )
    throw createError({ statusCode: 502, statusMessage: 'V3 upstream unavailable' })
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
