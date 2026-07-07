/**
 * Server-side proxy for Morpho's GraphQL API.
 *
 * Cross-protocol migration reads wallet-specific positions and compatible targets.
 * Keep the upstream server-side for CSP consistency and bypass persistent TTL
 * caching so a just-created/closed position does not stay visible in Lite.
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

const MORPHO_GRAPHQL_URL = 'https://api.morpho.org/graphql'
const BROWSER_CACHE_CONTROL = 'no-store'

// The only operation Lite's Morpho migration connector sends to this proxy.
const MORPHO_ALLOWED_OPERATIONS = ['EulerMigrationMorphoMarkets'] as const

const cache = createProxyCache(0)
const inFlight = createProxyInFlight()

const rateLimiter = createRateLimiter({
  max: 300,
  windowMs: 60_000,
  label: 'morpho-proxy',
})

export default defineEventHandler(async (event) => {
  if (getMethod(event).toUpperCase() !== 'POST') {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }
  await rateLimiter.consume(event)

  const body = assertAllowedGraphqlRequest(
    (await readRawBody(event))?.toString() ?? '',
    getRequestHeader(event, 'content-type') ?? '',
    { allowedOperations: MORPHO_ALLOWED_OPERATIONS },
  )

  try {
    const res = await forwardProxied({
      cache,
      inFlight,
      method: 'POST',
      target: MORPHO_GRAPHQL_URL,
      headers: { 'accept': 'application/json', 'content-type': 'application/json' },
      body,
      ctx: 'morpho-proxy',
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
    logger.warn({ ctx: 'morpho-proxy', err }, 'upstream failed')
    throw createError({ statusCode: 502, statusMessage: 'Morpho upstream unavailable' })
  }
})
