/**
 * Read-only proxy for Merkl opportunity (campaign) data.
 *
 * Consolidates the Merkl opportunity types (EULER, MULTILENDBORROW,
 * ERC20LOGPROCESSOR, EULER_BORROW_FROM_COLLATERAL,
 * EULER_MULTI_BORROW_FROM_COLLATERAL) — each paginated internally up to
 * 10x100 items — into a single response so useMerkl() makes one proxy
 * call per chain instead of 5+ on every tick.
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
import { reportStatus } from '~/server/utils/log'
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

const MERKL_TYPES: MerklOpportunityType[] = [
  'EULER',
  'MULTILENDBORROW',
  'ERC20LOGPROCESSOR',
  'EULER_BORROW_FROM_COLLATERAL',
  'EULER_MULTI_BORROW_FROM_COLLATERAL',
]

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

  const results = await Promise.allSettled(
    MERKL_TYPES.map(type => resolveOpportunity(chainId, type)),
  )

  const euler = results[0].status === 'fulfilled' ? results[0].value : []
  const multi = results[1].status === 'fulfilled' ? results[1].value : []
  const erc20 = results[2].status === 'fulfilled' ? results[2].value : []
  const borrowFromCollateral = results[3].status === 'fulfilled' ? results[3].value : []
  const multiBorrowFromCollateral = results[4].status === 'fulfilled' ? results[4].value : []

  // Log individual failures on state transition but don't fail the whole response
  for (const [i, type] of MERKL_TYPES.entries()) {
    const result = results[i]
    if (result.status === 'rejected') {
      const msg = result.reason instanceof Error ? result.reason.message : String(result.reason)
      reportStatus('rewards-merkl', `cold-path:${type}:${chainId}`, `failed:${msg}`,
        `${type} failed chain=${chainId}: ${msg}`)
    }
    else {
      reportStatus('rewards-merkl', `cold-path:${type}:${chainId}`, 'ok')
    }
  }

  // Only fail if every subtype failed — partial data is better than none
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
      euler_borrow_from_collateral: borrowFromCollateral,
      euler_multi_borrow_from_collateral: multiBorrowFromCollateral,
    },
  }
})

// Referenced so the warm-cache plugin can pre-populate each type without
// re-declaring the list.
export { MERKL_TYPES }
export type { CachedEntry }
