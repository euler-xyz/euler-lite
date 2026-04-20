import { createError, setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { logWarn } from '~/server/utils/log'
import { resolveChainId } from '~/server/utils/resolve-chain-id'
import { vaultsCache, refreshChainVaults } from '~/server/utils/vaults-cache'

const rateLimiter = createRateLimiter({
  max: 600,
  windowMs: 60_000,
  label: 'vaults',
})

/**
 * Read-only handler for the chain vaults snapshot.
 *
 * - Steady state: the warm-cache plugin rewrites each entry every 5 min
 *   via direct `refreshChainVaults()` call (force-refresh). Hits always
 *   land in a <5 min-old cache. No refresh triggered per request.
 * - After extended warm-cache failure: stale data served up to the
 *   staleness ceiling, then cold-path falls back to a synchronous refresh.
 * - Cold start (before first warm cycle completes): handler awaits the
 *   refresh. In-flight dedup in vaults-cache collapses concurrent cold
 *   requests onto a single upstream pass.
 */
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
    setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')
    return result
  }
  catch (err) {
    logWarn('vaults', `Cold fetch failed for chain ${chainId}:`, err instanceof Error ? err.message : err)
    throw createError({ statusCode: 502, statusMessage: 'Upstream vault load failed' })
  }
})
