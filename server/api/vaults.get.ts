/**
 * Read-only `/api/vaults?chainId=N` endpoint.
 *
 * Steady state: the warm-cache plugin rewrites each chain's entry every
 * 5 min via direct `refreshChainVaults()` call. Hits always land in a
 * <5 min cache. No refresh triggered per request.
 *
 * After extended warm-cache failure: stale data is served up to the
 * staleness ceiling; past that, the cold path falls back to a synchronous
 * refresh.
 *
 * Cold start (before the first warm cycle): handler awaits the refresh.
 * In-flight dedup in vaults-cache collapses concurrent cold requests onto
 * a single upstream pass.
 */
import { createError, setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { resolveChainId } from '~/server/utils/resolve-chain-id'
import { reportStatus } from '~/server/utils/log'
import { refreshChainVaults, vaultsCache } from '~/server/utils/vaults-cache'

const rateLimiter = createRateLimiter({
  max: 600,
  windowMs: 60_000,
  label: 'vaults',
})

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const chainId = resolveChainId(event)
  const cacheKey = String(chainId)
  const cached = vaultsCache.get(cacheKey) ?? vaultsCache.getStale(cacheKey)
  if (cached) {
    setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')
    return cached
  }

  try {
    const result = await refreshChainVaults(chainId)
    reportStatus('vaults', `cold-path:${chainId}`, 'ok')
    setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')
    return result
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    reportStatus(
      'vaults',
      `cold-path:${chainId}`,
      `failed:${msg}`,
      `cold fetch failed for chain ${chainId}: ${msg}`,
    )
    throw createError({ statusCode: 502, statusMessage: 'Upstream vault load failed' })
  }
})
