import {
  createError,
  getMethod,
  getRequestHeaders,
  getRequestURL,
  readRawBody,
  setResponseHeaders,
  setResponseStatus,
} from 'h3'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import {
  buildV3ProxyRequestHeaders,
  buildV3ProxyTarget,
  getV3ProxyPath,
  isV3ProxyPathAllowed,
  readForwardedV3ResponseHeaders,
} from '~/server/utils/v3-proxy'

const ALLOWED_METHODS = new Set(['GET', 'HEAD', 'POST'])

export default defineEventHandler(async (event) => {
  const method = getMethod(event).toUpperCase()
  if (!ALLOWED_METHODS.has(method)) {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }

  const requestUrl = getRequestURL(event)
  const proxyPath = getV3ProxyPath(requestUrl)
  if (!isV3ProxyPathAllowed(proxyPath)) {
    throw createError({ statusCode: 404, statusMessage: 'V3 path not allowed' })
  }

  const target = buildV3ProxyTarget(requestUrl)
  const headers = buildV3ProxyRequestHeaders(getRequestHeaders(event))
  const body = method === 'GET' || method === 'HEAD'
    ? undefined
    : await readRawBody(event)

  const upstream = await fetchWithTimeout(target, undefined, {
    method,
    headers,
    body,
  })

  setResponseStatus(event, upstream.status, upstream.statusText)
  setResponseHeaders(event, readForwardedV3ResponseHeaders(upstream.headers))

  if (method === 'HEAD' || upstream.status === 204 || upstream.status === 304) {
    return undefined
  }

  return await upstream.text()
})
