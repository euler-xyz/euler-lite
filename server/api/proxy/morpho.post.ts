/**
 * Server-side proxy for Morpho's GraphQL API.
 *
 * Cross-protocol migration discovery reads wallet-specific Morpho positions.
 * Keep the upstream server-side for CSP consistency and bypass persistent TTL
 * caching so a just-created/closed position does not stay visible in Lite.
 */
import {
  createError,
  getMethod,
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

const MORPHO_GRAPHQL_URL = 'https://api.morpho.org/graphql'
const BROWSER_CACHE_CONTROL = 'no-store'

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

  const body = (await readRawBody(event))?.toString() ?? ''
  if (!body) {
    throw createError({ statusCode: 400, statusMessage: 'Empty GraphQL body' })
  }

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
