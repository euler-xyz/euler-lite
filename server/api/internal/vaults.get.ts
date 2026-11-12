/**
 * Read-only `/api/internal/vaults?chainId=N` endpoint.
 *
 * The warm-cache plugin refreshes non-deprecated chains every 1 min with V3
 * enabled, otherwise 5 min. Requests resolve the current chain policy and
 * return its usable cached snapshot without refreshing vault data.
 *
 * After extended warm-cache failure: stale data is served up to the
 * staleness ceiling; past that, the cold path falls back to a synchronous
 * refresh.
 *
 * With no usable snapshot for the current policy (cold start, policy change,
 * or stale expiry), the handler awaits a refresh. In-flight dedup is scoped
 * to the chain and policy.
 */
import { createError, setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { resolveChainId } from '~/server/utils/resolve-chain-id'
import { reportStatus } from '~/server/utils/log'
import { refreshChainVaults, vaultsCache, vaultsCacheKey } from '~/server/utils/vaults-cache'
import { loadServerChainReadPolicy } from '~/server/utils/chain-policy'
import { readDisableServerVaultCache } from '~/utils/api-url-env'

const rateLimiter = createRateLimiter({
  max: 600,
  windowMs: 60_000,
  label: 'vaults',
})

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  // Operator opt-out: when the snapshot is disabled the endpoint is
  // unavailable, the warm cycle doesn't run, and the browser's
  // hydrateFromServer treats this as a hydrate failure and falls through
  // to the chain-aware browser SDK. Returning 503 (vs 404) signals "feature
  // intentionally disabled" rather than "route not found".
  if (readDisableServerVaultCache()) {
    throw createError({ statusCode: 503, statusMessage: 'Vault snapshot disabled' })
  }

  const chainId = resolveChainId(event)
  try {
    const cacheKey = vaultsCacheKey(chainId, await loadServerChainReadPolicy(chainId))
    const cached = vaultsCache.get(cacheKey) ?? vaultsCache.getStale(cacheKey)
    if (cached) {
      setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')
      return cached
    }

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
