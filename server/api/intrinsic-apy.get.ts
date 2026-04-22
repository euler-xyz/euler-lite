import { setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { getIntrinsicApyForChain } from '~/server/utils/intrinsic-apy'
import { resolveChainId } from '~/server/utils/resolve-chain-id'
import { logWarn } from '~/server/utils/log'

/**
 * Consolidated intrinsic-APY proxy. Client issues one request per chain
 * and receives a flat `{ [lowercaseAddress]: { apy, provider, source? } }`
 * map with every APY we can resolve from `intrinsicApySources`. All
 * provider-specific upstream fetching, filtering, and extraction happens
 * server-side — no giant payloads and no provider-awareness on the client.
 */

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'intrinsic-apy',
})

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const chainId = resolveChainId(event)

  try {
    const result = await getIntrinsicApyForChain(chainId)
    // Cloudflare can short-circuit repeat hits between warm cycles.
    setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')
    return result
  }
  catch (err) {
    logWarn('intrinsic-apy', `Failed to resolve chain ${chainId}:`, err instanceof Error ? err.message : err)
    return {}
  }
})
