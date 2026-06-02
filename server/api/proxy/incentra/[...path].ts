/**
 * Server-side proxy for the Incentra (Brevis) rewards API.
 *
 * SDK config slots:
 *   - rewardsBrevisApiUrl      → defaults to /sdk/v1/eulerCampaigns (POST)
 *   - rewardsBrevisProofsApiUrl → defaults to /v1/getMerkleProofsBatch (POST)
 *
 * Point both at this proxy (`/api/proxy/incentra/sdk/v1/eulerCampaigns`,
 * `/api/proxy/incentra/v1/getMerkleProofsBatch`). The handler reads the
 * upstream base from `INCENTRA_API_URL` (default
 * `https://incentra-prd.brevis.network`) and forwards the request body
 * verbatim. Responses are TTL-cached server-side by (method + target +
 * body hash) for cross-tab sharing.
 */
import {
  createError,
  getMethod,
  getRequestURL,
  readRawBody,
  setResponseHeaders,
  setResponseStatus,
} from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { logger } from '~/server/utils/logger'
import {
  createProxyCache,
  createProxyInFlight,
  forwardProxied,
} from '~/server/utils/external-proxy'
import { isAllowedIncentraProxyRequest } from '~/server/utils/rewards-proxy-allowlist'

const PROXY_PREFIX = '/api/proxy/incentra/'

const DEFAULT_INCENTRA_API_URL = 'https://incentra-prd.brevis.network'

const INCENTRA_API_URL_ENV_KEYS = ['INCENTRA_API_URL', 'NUXT_PUBLIC_INCENTRA_API_URL'] as const

const CACHE_TTL_MS = 60_000
const BROWSER_CACHE_CONTROL = 'public, max-age=30, stale-while-revalidate=30'

const cache = createProxyCache(CACHE_TTL_MS)
const inFlight = createProxyInFlight()

const rateLimiter = createRateLimiter({
  max: 600,
  windowMs: 60_000,
  label: 'incentra-proxy',
})

const stripLeadingSlash = (s: string): string => (s.startsWith('/') ? s.slice(1) : s)

const readUpstreamBase = (): string => {
  for (const key of INCENTRA_API_URL_ENV_KEYS) {
    const v = process.env[key]
    if (v && v.trim()) return v.trim().replace(/\/+$/, '')
  }
  return DEFAULT_INCENTRA_API_URL
}

export default defineEventHandler(async (event) => {
  const method = getMethod(event).toUpperCase()
  if (method !== 'POST') {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }

  const requestUrl = getRequestURL(event)
  const idx = requestUrl.pathname.indexOf(PROXY_PREFIX)
  if (idx < 0) {
    throw createError({ statusCode: 404, statusMessage: 'Not an incentra proxy path' })
  }
  const rest = stripLeadingSlash(requestUrl.pathname.slice(idx + PROXY_PREFIX.length))
  if (!isAllowedIncentraProxyRequest(method, rest, requestUrl.searchParams)) {
    throw createError({ statusCode: 404, statusMessage: 'Incentra path not allowed' })
  }

  const target = `${readUpstreamBase()}/${rest}${requestUrl.search}`
  const body = method === 'POST' ? (await readRawBody(event))?.toString() : undefined

  await rateLimiter.consume(event)

  try {
    const res = await forwardProxied({
      cache,
      inFlight,
      method,
      target,
      headers: { accept: 'application/json', ...(body ? { 'content-type': 'application/json' } : {}) },
      body,
      ctx: 'incentra-proxy',
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
    logger.warn({ ctx: 'incentra-proxy', target, err }, 'upstream failed')
    throw createError({ statusCode: 502, statusMessage: 'Incentra upstream unavailable' })
  }
})
