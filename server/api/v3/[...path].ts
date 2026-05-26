import {
  createError,
  getMethod,
  getRequestURL,
  readRawBody,
  setResponseHeaders,
  setResponseStatus,
} from 'h3'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { createRateLimiter } from '~/server/utils/rate-limit'
import {
  buildV3ProxyRequestHeaders,
  buildV3ProxyTarget,
  readForwardedV3ResponseHeaders,
  validateV3ProxyUrl,
} from '~/server/utils/v3-proxy'

const ALLOWED_METHODS = new Set(['GET', 'POST'])

const rateLimiter = createRateLimiter({
  max: 600,
  windowMs: 60_000,
  label: 'v3-proxy',
})

export default defineEventHandler(async (event) => {
  const method = getMethod(event).toUpperCase()
  if (!ALLOWED_METHODS.has(method)) {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }

  const requestUrl = getRequestURL(event)
  const urlValidation = validateV3ProxyUrl(method, requestUrl)
  if (!urlValidation.ok) {
    throw createError({ statusCode: urlValidation.statusCode, statusMessage: urlValidation.statusMessage })
  }
  rateLimiter.consume(event, method === 'POST' ? 5 : 1)

  const target = buildV3ProxyTarget(requestUrl)
  const headers = buildV3ProxyRequestHeaders(method)
  const body = method === 'POST' ? await readRawBody(event) : undefined

  const upstream = await fetchWithTimeout(target, undefined, {
    method,
    headers,
    body,
  })

  setResponseStatus(event, upstream.status, upstream.statusText)
  setResponseHeaders(event, readForwardedV3ResponseHeaders(upstream.headers))

  if (upstream.status === 204 || upstream.status === 304) {
    return undefined
  }

  return await upstream.text()
})
