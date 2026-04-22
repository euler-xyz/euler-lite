/**
 * Read-only proxy for Brevis (Incentra) public campaigns.
 *
 * Wraps the upstream POST as a GET for uniform client-side caching. The
 * POST body is deterministic from chainId so the cache key reduces to
 * `brevis:{chainId}`. User-specific /getMerkleProofsBatch stays direct
 * from the browser — not exposed through this proxy.
 */
import { createError, setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { logWarn } from '~/server/utils/log'
import { resolveChainId } from '~/server/utils/resolve-chain-id'
import {
  readBrevis,
  refreshBrevisCampaigns,
  scheduleRevalidation,
} from '~/server/utils/rewards-cache'

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'rewards-brevis-proxy',
})

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const chainId = resolveChainId(event)

  try {
    const cached = readBrevis(chainId)
    let data: unknown
    if (cached && !cached.isStale) {
      data = cached.data
    }
    else if (cached && cached.isStale) {
      scheduleRevalidation(`brevis chain=${chainId}`, () => refreshBrevisCampaigns(chainId))
      data = cached.data
    }
    else {
      data = await refreshBrevisCampaigns(chainId)
    }

    setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')
    return data
  }
  catch (err) {
    if (err && typeof err === 'object' && 'statusCode' in err) {
      throw err
    }
    logWarn('rewards-brevis', `cold fetch failed chain=${chainId}:`, err instanceof Error ? err.message : err)
    throw createError({ statusCode: 502, statusMessage: 'Brevis upstream error' })
  }
})
