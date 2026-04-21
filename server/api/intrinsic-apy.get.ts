import { setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { getIntrinsicApyForChain } from '~/server/utils/intrinsic-apy'
import { resolveChainId } from '~/server/utils/resolve-chain-id'
import { reportStatus } from '~/server/utils/log'

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
    reportStatus('intrinsic-apy', `handler:${chainId}`, 'ok')
    // Cloudflare can short-circuit repeat hits between warm cycles.
    setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')
    return result
  }
  catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    reportStatus('intrinsic-apy', `handler:${chainId}`, `failed:${msg}`,
      `failed to resolve chain ${chainId}: ${msg}`)
    return {}
  }
})
