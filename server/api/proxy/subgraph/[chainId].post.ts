/**
 * Server-side proxy for the per-chain Goldsky subgraph.
 *
 * The SDK's vaultTypeSubgraphAdapter and accountVaultsSubgraphAdapter POST
 * GraphQL queries directly to per-chain URLs. With this proxy in place we
 * point both adapters at `/api/proxy/subgraph/{chainId}`, the handler
 * resolves the real upstream from env and forwards the GraphQL payload.
 *
 * No server-side TTL cache: the subgraph serves freshness-critical
 * wallet-specific data (account positions read right after a deposit/borrow),
 * and caching it caused just-confirmed positions to stay hidden for up to a
 * minute. Vault catalogue freshness is handled separately by the dedicated
 * vault snapshot cache (`server/utils/vaults-cache.ts`) and the SDK's own
 * client-side query cache. In-flight dedup is kept so concurrent identical
 * requests still coalesce into one upstream round-trip without persisting.
 *
 * Upstream resolution order (first non-empty wins):
 *   1. `SUBGRAPH_URL_<chainId>` (preferred, server-only)
 *   2. `NUXT_PUBLIC_SUBGRAPH_URI_<chainId>` (legacy). The `NUXT_PUBLIC_` prefix
 *      is now vestigial: the URL is resolved here server-side only and is no
 *      longer exposed to the client (all subgraph traffic is proxied), so this
 *      var can be renamed to `SUBGRAPH_URL_<chainId>` at the deploy's
 *      convenience.
 *
 * If no upstream is configured for the chain, returns 404 so the caller
 * falls through to the SDK's onchain secondary.
 */
import {
  createError,
  getMethod,
  getRouterParam,
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

const resolveSubgraphUrl = (chainId: number): string | undefined => {
  const candidates = [
    process.env[`SUBGRAPH_URL_${chainId}`],
    process.env[`NUXT_PUBLIC_SUBGRAPH_URI_${chainId}`],
  ]
  for (const v of candidates) {
    if (v && v.trim()) return v.trim()
  }
  return undefined
}

export default defineEventHandler(async (event) => {
  if (getMethod(event).toUpperCase() !== 'POST') {
    throw createError({ statusCode: 405, statusMessage: 'Method not allowed' })
  }
  await rateLimiter.consume(event)

  const chainIdRaw = getRouterParam(event, 'chainId')
  const chainId = Number(chainIdRaw)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid chainId' })
  }

  const target = resolveSubgraphUrl(chainId)
  if (!target) {
    throw createError({ statusCode: 404, statusMessage: `No subgraph configured for chain ${chainId}` })
  }

  const body = (await readRawBody(event))?.toString() ?? ''
  if (!body) {
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
    logger.warn({ ctx: 'subgraph-proxy', chainId, err }, 'upstream failed')
    throw createError({ statusCode: 502, statusMessage: 'Subgraph upstream unavailable' })
  }
})
