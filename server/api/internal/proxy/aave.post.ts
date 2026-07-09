/**
 * Server-side proxy for Aave's GraphQL API.
 *
 * Migration target discovery needs Aave deployment metadata that the browser
 * cannot fetch directly under the app CSP. Keep this same-origin and uncached
 * so market/liquidity data reflects the upstream response for each scan.
 */
import {
  createError,
  getMethod,
  getRequestHeader,
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
import { assertAllowedGraphqlRequest } from '~/server/utils/graphql-proxy-guard'

const AAVE_GRAPHQL_URL = 'https://api.v3.aave.com/graphql'
const BROWSER_CACHE_CONTROL = 'no-store'

// The only operation Lite's Aave migration connector sends to this proxy.
const AAVE_ALLOWED_OPERATIONS = ['AaveMigrationMarkets'] as const

const cache = createProxyCache(0)
const inFlight = createProxyInFlight()

const rateLimiter = createRateLimiter({
  max: 300,
  windowMs: 60_000,
  label: 'aave-proxy',
})

export default defineEventHandler(async (event) => {
  if (getMethod(event).toUpperCase() !== 'POST') {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }
  await rateLimiter.consume(event)

  const body = assertAllowedGraphqlRequest(
    (await readRawBody(event))?.toString() ?? '',
    getRequestHeader(event, 'content-type') ?? '',
    { allowedOperations: AAVE_ALLOWED_OPERATIONS },
  )

  try {
    const res = await forwardProxied({
      cache,
      inFlight,
      method: 'POST',
      target: AAVE_GRAPHQL_URL,
      headers: { 'accept': 'application/json', 'content-type': 'application/json' },
      body,
      ctx: 'aave-proxy',
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
    logger.warn({ ctx: 'aave-proxy', err }, 'upstream failed')
    throw createError({ statusCode: 502, statusMessage: 'Aave upstream unavailable' })
  }
})
