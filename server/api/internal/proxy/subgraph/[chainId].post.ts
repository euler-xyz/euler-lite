import {
  createError,
  getMethod,
  getRouterParam,
  readRawBody,
  setResponseHeaders,
  setResponseStatus,
} from 'h3'
import { resolveSubgraphSource, SubgraphUnavailableError, type SubgraphSource } from '~/server/utils/subgraph-catalog'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { logger } from '~/server/utils/logger'
import { GRAPHQL_RESPONSE_BUDGET } from '~/server/utils/fetch-text-with-budget'
import { safeErrorLogFields, safeUrlLogFields } from '~/server/utils/observability'
import {
  createProxyCache,
  createProxyInFlight,
  forwardProxied,
} from '~/server/utils/external-proxy'

const BROWSER_CACHE_CONTROL = 'no-store'

// `forwardProxied` requires a cache instance even when bypassed; this one is
// never written to (every call passes `bypassCache: true`). In-flight dedup
// still coalesces concurrent identical requests.
const cache = createProxyCache(0)
const inFlight = createProxyInFlight()

const rateLimiter = createRateLimiter({
  max: 600,
  windowMs: 60_000,
  label: 'subgraph-proxy',
})

export default defineEventHandler(async (event) => {
  const method = getMethod(event).toUpperCase()
  if (method !== 'POST') {
    logger.warn({ ctx: 'subgraph-proxy', method, reason: 'invalid-method' }, 'request rejected')
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }
  await rateLimiter.consume(event)

  const chainIdRaw = getRouterParam(event, 'chainId')
  const chainId = Number(chainIdRaw)
  if (!Number.isSafeInteger(chainId) || chainId <= 0) {
    logger.warn({ ctx: 'subgraph-proxy', chainIdRaw, reason: 'invalid-chain-id' }, 'request rejected')
    throw createError({ statusCode: 400, statusMessage: 'Invalid chainId' })
  }

  setResponseHeaders(event, { 'cache-control': BROWSER_CACHE_CONTROL })
  let source: SubgraphSource
  try {
    source = await resolveSubgraphSource(chainId)
  }
  catch (error) {
    const reason = error instanceof SubgraphUnavailableError ? error.reason : 'catalog-unavailable'
    throw createError({ statusCode: reason === 'missing' ? 404 : 503, statusMessage: `Subgraph unavailable: ${reason}` })
  }
  const target = source.endpoint

  const body = (await readRawBody(event))?.toString() ?? ''
  if (!body) {
    logger.warn({ ctx: 'subgraph-proxy', chainId, reason: 'empty-body' }, 'request rejected')
    throw createError({ statusCode: 400, statusMessage: 'Empty GraphQL body' })
  }

  try {
    const res = await forwardProxied({
      cache,
      inFlight,
      method: 'POST',
      target,
      headers: { 'accept': 'application/json', 'content-type': 'application/json' },
      body,
      ctx: 'subgraph-proxy',
      bypassCache: true,
      redirect: 'error',
      responseBudget: GRAPHQL_RESPONSE_BUDGET,
    })
    // Checked clients include _meta in the actual data query, so alias drift is
    // detected on the response that supplies account membership/factory data.
    if (source.deploymentId) {
      const payload = JSON.parse(res.body)
      if (payload?.data?._meta?.deployment !== source.deploymentId) {
        throw new Error('Subgraph deployment identity mismatch')
      }
    }
    setResponseStatus(event, res.status, res.statusText)
    setResponseHeaders(event, {
      'content-type': res.contentType,
      'cache-control': BROWSER_CACHE_CONTROL,
      'x-cache': res.cacheState,
      'x-subgraph-source': source.identity,
    })
    return res.body
  }
  catch (err) {
    logger.warn(
      {
        ctx: 'subgraph-proxy',
        chainId,
        ...safeUrlLogFields(target),
        err: safeErrorLogFields(err),
      },
      'upstream failed',
    )
    throw createError({ statusCode: 502, statusMessage: 'Subgraph upstream unavailable' })
  }
})
