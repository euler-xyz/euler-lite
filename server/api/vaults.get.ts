import { createError, getQuery, setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { logWarn } from '~/server/utils/log'
import { vaultsCache, refreshChainVaults } from '~/server/utils/vaults-cache'
import { getEnabledChainIds } from '~/utils/chain-env'

const rateLimiter = createRateLimiter({
  max: 600,
  windowMs: 60_000,
  label: 'vaults',
})

/**
 * Read-only handler for the chain vaults snapshot.
 *
 * - Steady state: the warm-cache plugin rewrites each entry every 4 min.
 *   Hits always land in a <4 min-old cache. No refresh triggered per request.
 * - After extended warm-cache failure: stale data served up to the 10 min
 *   TTL, then cold-path falls back to a synchronous refresh.
 * - Cold start (before first warm cycle completes): handler awaits the
 *   refresh. In-flight dedup in vaults-cache collapses concurrent cold
 *   requests onto a single upstream pass.
 */
export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const chainId = Number(getQuery(event).chainId)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid chainId' })
  }
  if (!getEnabledChainIds().includes(chainId)) {
    throw createError({ statusCode: 400, statusMessage: 'Unsupported chainId' })
  }

  const cacheKey = String(chainId)
  const cached = vaultsCache.get(cacheKey) ?? vaultsCache.getStale(cacheKey)
  if (cached) {
    setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')
    return cached
  }

  try {
    const result = await refreshChainVaults(chainId)
    setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')
    return result
  }
  catch (err) {
    logWarn('vaults', `Cold fetch failed for chain ${chainId}:`, err instanceof Error ? err.message : err)
    throw createError({ statusCode: 502, statusMessage: 'Upstream vault load failed' })
  }
})
