import {
  createError,
  getMethod,
  getRequestURL,
  setResponseHeaders,
  setResponseStatus,
} from 'h3'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { logger } from '~/server/utils/logger'

/**
 * Server-side proxy for Merkl v4 opportunity / user-reward endpoints.
 *
 * The SDK's rewardsDirectAdapter fetches `${merklApiUrl}/opportunities?...`
 * directly from the browser. api.merkl.xyz doesn't set permissive CORS
 * headers, so direct fetches from the lite origin fail with `ERR_FAILED`.
 *
 * Configure the SDK with `directAdapterConfig.merklApiUrl = '/api/proxy/merkl'`
 * and this handler rewrites the path to `https://api.merkl.xyz/v4/<path>`
 * plus the original query string, forwards the response, and tags the
 * response with permissive caching headers so the browser can reuse it.
 */

const MERKL_UPSTREAM_BASE = 'https://api.merkl.xyz/v4'
const ALLOWED_METHODS = new Set(['GET', 'HEAD'])

// Only allow paths the rewards adapter actually hits. Anything else 404s so
// the endpoint isn't a generic open proxy.
const ALLOWED_PATH_PREFIXES = [
  'opportunities',
  'users',
  'campaigns',
]

const rateLimiter = createRateLimiter({
  max: 600,
  windowMs: 60_000,
  label: 'merkl-proxy',
})

const stripLeadingSlash = (s: string): string => (s.startsWith('/') ? s.slice(1) : s)

const isAllowedPath = (path: string): boolean => {
  const head = path.split('/')[0]?.toLowerCase() ?? ''
  return ALLOWED_PATH_PREFIXES.includes(head)
}

export default defineEventHandler(async (event) => {
  const method = getMethod(event).toUpperCase()
  if (!ALLOWED_METHODS.has(method)) {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }

  await rateLimiter.consume(event)

  const requestUrl = getRequestURL(event)
  // Nuxt strips the catch-all prefix into `event.context.params.path` as an
  // array OR string; recompute from the URL pathname to handle both shapes
  // and to keep nested slashes intact.
  const prefix = '/api/proxy/merkl/'
  const idx = requestUrl.pathname.indexOf(prefix)
  if (idx < 0) {
    throw createError({ statusCode: 404, statusMessage: 'Not a merkl proxy path' })
  }
  const rest = stripLeadingSlash(requestUrl.pathname.slice(idx + prefix.length))
  if (!isAllowedPath(rest)) {
    throw createError({ statusCode: 404, statusMessage: 'Merkl path not allowed' })
  }

  const target = `${MERKL_UPSTREAM_BASE}/${rest}${requestUrl.search}`

  let upstream: Response
  try {
    upstream = await fetchWithTimeout(target, undefined, {
      method,
      headers: { accept: 'application/json' },
    })
  }
  catch (err) {
    logger.warn({ ctx: 'merkl-proxy', target, err }, 'upstream fetch failed')
    throw createError({ statusCode: 502, statusMessage: 'Merkl upstream unavailable' })
  }

  setResponseStatus(event, upstream.status, upstream.statusText)
  setResponseHeaders(event, {
    'content-type': upstream.headers.get('content-type') ?? 'application/json',
    // Short edge cache: the adapter polls these on its own cadence; this
    // lets concurrent tabs from the same origin share a response.
    'cache-control': 'public, max-age=60',
  })

  if (method === 'HEAD' || upstream.status === 204 || upstream.status === 304) {
    return undefined
  }

  return await upstream.text()
})
