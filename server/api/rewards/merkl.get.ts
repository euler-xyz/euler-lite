/**
 * Read-only proxy for Merkl opportunity (campaign) data.
 *
 * Consolidates the three opportunity types (EULER, MULTILENDBORROW,
 * ERC20LOGPROCESSOR) — each paginated internally up to 10x100 items —
 * into a single response so useMerkl() makes one proxy call per chain
 * instead of 3+ on every tick.
 *
 * Merkl's global `/tokens/reward` payload is NOT returned here. It's
 * a 4th source inside `/api/token-list` (see fetchMerkl there), covering
 * reward-specific tokens (rEUL, project-specific tokens) that may not
 * appear in the general token lists. The client looks up reward-token
 * metadata from the unified token list like any other token.
 *
 * SWR semantics per sub-key:
 *   fresh → return synchronously
 *   stale → return stale + schedule background revalidation
 *   cold  → await upstream; 502 on failure
 *
 * Each Merkl opportunity type caches separately so one upstream flake
 * (e.g. ERC20LOGPROCESSOR) does not poison the entire provider slot.
 */
import { createError, setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { logWarn } from '~/server/utils/log'
import { resolveChainId } from '~/server/utils/resolve-chain-id'
import {
  type CachedEntry,
  type MerklOpportunityType,
  readMerklType,
  refreshMerklType,
  scheduleRevalidation,
} from '~/server/utils/rewards-cache'

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'rewards-merkl-proxy',
})

const MERKL_TYPES: MerklOpportunityType[] = ['EULER', 'MULTILENDBORROW', 'ERC20LOGPROCESSOR']

const resolveOpportunity = async (
  chainId: number,
  type: MerklOpportunityType,
): Promise<unknown[]> => {
  const cached = readMerklType(chainId, type)
  if (cached && !cached.isStale) return cached.data
  if (cached && cached.isStale) {
    scheduleRevalidation(`merkl/${type} chain=${chainId}`, () => refreshMerklType(chainId, type))
    return cached.data
  }
  return refreshMerklType(chainId, type)
}

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const chainId = resolveChainId(event)

  const results = await Promise.allSettled([
    resolveOpportunity(chainId, 'EULER'),
    resolveOpportunity(chainId, 'MULTILENDBORROW'),
    resolveOpportunity(chainId, 'ERC20LOGPROCESSOR'),
  ])

  const euler = results[0].status === 'fulfilled' ? results[0].value : []
  const multi = results[1].status === 'fulfilled' ? results[1].value : []
  const erc20 = results[2].status === 'fulfilled' ? results[2].value : []

  // Log individual failures but don't fail the whole response
  for (const [i, type] of MERKL_TYPES.entries()) {
    const result = results[i]
    if (result.status === 'rejected') {
      logWarn('rewards-merkl', `${type} failed chain=${chainId}:`, result.reason instanceof Error ? result.reason.message : result.reason)
    }
  }

  // Only fail if all three subtypes failed — partial data is better than none
  if (results.every(r => r.status === 'rejected')) {
    throw createError({ statusCode: 502, statusMessage: 'Merkl upstream error' })
  }

  // Clients poll in lockstep — letting Cloudflare short-circuit the repeat
  // polls between warm cycles skips Nitro entirely for most hits.
  setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')

  return {
    opportunities: {
      euler,
      multilendborrow: multi,
      erc20logprocessor: erc20,
    },
  }
})

// Referenced so the warm-cache plugin can pre-populate each type without
// re-declaring the list.
export { MERKL_TYPES }
export type { CachedEntry }
