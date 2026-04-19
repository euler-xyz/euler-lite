/**
 * Read-only proxy for Merkl opportunity (campaign) data.
 *
 * Consolidates the three opportunity types (EULER, MULTILENDBORROW,
 * ERC20LOGPROCESSOR) — each paginated internally up to 10x100 items —
 * into a single response so useMerkl() makes one proxy call per chain
 * instead of 3+ on every tick.
 *
 * Merkl's global `/tokens/reward` payload is NOT returned here. It's
 * merged into `/api/token-list` as a fallback source for reward-specific
 * tokens (e.g. rEUL, project-specific tokens) that may not appear in the
 * general-purpose lists. The client looks up reward-token metadata from
 * the unified token list like any other token.
 * See server/utils/rewards-cache.ts:getMerklRewardTokensForChain.
 *
 * SWR semantics per sub-key:
 *   fresh → return synchronously
 *   stale → return stale + schedule background revalidation
 *   cold  → await upstream; 502 on failure
 *
 * Each Merkl opportunity type caches separately so one upstream flake
 * (e.g. ERC20LOGPROCESSOR) does not poison the entire provider slot.
 */
import { createError, getQuery, setResponseHeader } from 'h3'
import type { H3Event } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { logWarn } from '~/server/utils/log'
import { getEnabledChainIds } from '~/utils/chain-env'
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

const resolveChainId = (event: H3Event): number => {
  const raw = getQuery(event).chainId
  const chainId = Number(raw)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid chainId' })
  }
  if (!getEnabledChainIds().includes(chainId)) {
    throw createError({ statusCode: 400, statusMessage: 'Unsupported chainId' })
  }
  return chainId
}

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

  try {
    const [euler, multi, erc20] = await Promise.all([
      resolveOpportunity(chainId, 'EULER'),
      resolveOpportunity(chainId, 'MULTILENDBORROW'),
      resolveOpportunity(chainId, 'ERC20LOGPROCESSOR'),
    ])

    // Clients poll in lockstep — letting Cloudflare short-circuit the repeat
    // polls between warm cycles skips Nitro entirely for most hits.
    setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=300')

    return {
      opportunities: {
        euler,
        multilendborrow: multi,
        erc20logprocessor: erc20,
      },
    }
  }
  catch (err) {
    if (err && typeof err === 'object' && 'statusCode' in err) {
      throw err
    }
    logWarn('rewards-merkl', `cold fetch failed chain=${chainId}:`, err instanceof Error ? err.message : err)
    throw createError({ statusCode: 502, statusMessage: 'Merkl upstream error' })
  }
})

// Referenced so the warm-cache plugin can pre-populate each type without
// re-declaring the list.
export { MERKL_TYPES }
export type { CachedEntry }
