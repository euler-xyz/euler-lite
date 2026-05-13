import { createError, getMethod, getRequestURL, readRawBody, setResponseHeader, setResponseStatus } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { readV3ApiUrl } from '~/utils/api-url-env'
import { isAbortError } from '~/utils/errorHandling'

const rateLimiter = createRateLimiter({
  max: 10_000,
  windowMs: 60_000,
  label: 'v3-api',
})

const ALLOWED_METHODS = new Set(['GET', 'POST'])

function getUpstreamBaseUrl(): string {
  return readV3ApiUrl().trim().replace(/\/+$/, '') || 'https://v3.euler.finance'
}

export default defineEventHandler(async (event) => {
  const method = getMethod(event).toUpperCase()
  if (!ALLOWED_METHODS.has(method)) {
    throw createError({ statusCode: 405, statusMessage: 'Method Not Allowed' })
  }

  rateLimiter.consume(event)

  const path = String(event.context.params?.path || '')
    .split('/')
    .map(segment => encodeURIComponent(decodeURIComponent(segment)))
    .join('/')
  if (!path) {
    throw createError({ statusCode: 400, statusMessage: 'Missing V3 API path' })
  }

  const requestUrl = getRequestURL(event)
  const upstreamUrl = new URL(`${getUpstreamBaseUrl()}/${path}`)
  upstreamUrl.search = requestUrl.search

  const body = method === 'POST' ? await readRawBody(event, false) : undefined
  const contentType = event.node.req.headers['content-type']

  try {
    const response = await fetchWithTimeout(upstreamUrl.toString(), 30_000, {
      method,
      body,
      headers: contentType ? { 'content-type': contentType } : undefined,
    })

    setResponseStatus(event, response.status)
    setResponseHeader(event, 'cache-control', response.headers.get('cache-control') || 'no-store')
    setResponseHeader(event, 'content-type', response.headers.get('content-type') || 'application/json')

    return await response.text()
  }
  catch (error: unknown) {
    if (isAbortError(error)) {
      throw createError({ statusCode: 504, statusMessage: 'Upstream V3 API timeout' })
    }
    throw createError({ statusCode: 502, statusMessage: 'Upstream V3 API error' })
  }
})
