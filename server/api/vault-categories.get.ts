/**
 * Vault categorization endpoint.
 *
 * Replaces the old POST /api/vault-factories (per-address factory lookup).
 * Two modes driven by the optional `address` query param:
 *
 *   GET /api/vault-categories?chainId=X
 *     → full chain categorization:
 *         { evk: [...], earn: [...], securitize: [...], escrow: [...] }
 *       (`evk` is a superset that includes escrow addresses)
 *
 *   GET /api/vault-categories?chainId=X&address=0x…
 *     → single-address lookup:
 *         { category: 'evk' | 'earn' | 'securitize' | 'escrow' | null }
 *       The single-address mode is used by the client's resolveUnknown when
 *       the user navigates directly to a vault that isn't in the cached
 *       full categorization (e.g. just deployed). Falls back to a single-
 *       address subgraph query on miss.
 *
 * SWR semantics on the full-categorization cache:
 *   fresh → sync return
 *   stale → return stale + background revalidate
 *   cold  → await refresh; 502 on upstream failure
 */
import { createError, getQuery, setResponseHeader } from 'h3'
import { isAddress } from 'viem'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { resolveChainId } from '~/server/utils/resolve-chain-id'
import { logger } from '~/server/utils/logger'
import {
  getVaultCategories,
  getVaultCategory,
} from '~/server/utils/vault-categories-store'

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'vault-categories',
})

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const chainId = resolveChainId(event)
  const rawAddress = typeof getQuery(event).address === 'string' ? getQuery(event).address as string : undefined

  try {
    if (rawAddress) {
      if (!isAddress(rawAddress)) {
        throw createError({ statusCode: 400, statusMessage: 'Invalid address' })
      }
      const category = await getVaultCategory(chainId, rawAddress)
      // Single-address responses aren't cached at the edge — categories
      // for individual addresses can change if a newly-deployed vault is
      // later added to the escrow perspective; we want subsequent clients
      // to hit Nitro (which itself caches) rather than Cloudflare.
      setResponseHeader(event, 'Cache-Control', 'no-store')
      return { category: category ?? null }
    }

    const categories = await getVaultCategories(chainId)
    setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')
    return categories
  }
  catch (err) {
    if (err && typeof err === 'object' && 'statusCode' in err) throw err
    logger.warn({ ctx: 'vault-categories', chainId, err }, 'vault categories upstream error')
    throw createError({ statusCode: 502, statusMessage: 'Vault categories upstream error' })
  }
})
