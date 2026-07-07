import { createError, getQuery, setResponseHeader } from 'h3'
import { getAddress, isAddress } from 'viem'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { resolveRpcUrl } from '~/server/utils/rpc'
import { getChainVaultMetadata, type VaultMetadata } from '~/server/utils/vault-metadata'
import { logger } from '~/server/utils/logger'
import { parsePublicMetadataProductId } from '~/server/utils/public-metadata-query'

const MAX_ADDRESSES = 100

const rateLimiter = createRateLimiter({
  max: 100,
  windowMs: 60_000,
  label: 'public-metadata',
})

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const query = getQuery(event)

  const chainId = Number(query.chainId)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid chainId' })
  }
  if (!resolveRpcUrl(chainId)) {
    throw createError({ statusCode: 400, statusMessage: 'Unsupported chainId' })
  }

  const rawInput = query.addresses
  const raw = Array.isArray(rawInput)
    ? rawInput.filter((v): v is string => typeof v === 'string').join(',')
    : typeof rawInput === 'string' ? rawInput : ''
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean)
  if (parts.length > MAX_ADDRESSES) {
    throw createError({ statusCode: 400, statusMessage: `Too many addresses (max ${MAX_ADDRESSES})` })
  }

  const checksumed: string[] = []
  for (const addr of parts) {
    if (!isAddress(addr)) {
      throw createError({ statusCode: 400, statusMessage: `Invalid address: ${addr}` })
    }
    checksumed.push(getAddress(addr))
  }

  // Optional product filter. When present, only entries whose `productId`
  // equals this value are returned. Combines with `addresses` lookup mode:
  // an address that matches by lookup but belongs to a different product
  // returns `null`, matching the contract for unknown addresses.
  const productId = parsePublicMetadataProductId(query.productId)

  let metadataMap: Map<string, VaultMetadata>
  try {
    metadataMap = await getChainVaultMetadata(chainId)
  }
  catch (err) {
    logger.warn({ ctx: 'public-metadata', chainId, err }, 'metadata lookup failed')
    throw createError({ statusCode: 502, statusMessage: 'Upstream error' })
  }

  // Public bridge responses are CDN/browser cacheable for short bursts.
  // The warm-cache plugin keeps the upstream metadata map continuously fresh
  // so a stale CDN entry is never more than ~30s behind the server cache.
  setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')

  const matchesProduct = (m: VaultMetadata): boolean =>
    productId === null || m.productId === productId

  // No addresses supplied → list mode: emit every known vault (optionally
  // filtered by productId).
  if (checksumed.length === 0) {
    const out: Record<string, VaultMetadata> = {}
    for (const [addr, m] of metadataMap) {
      if (matchesProduct(m)) out[addr] = m
    }
    return out
  }

  const response: Record<string, VaultMetadata | null> = {}
  for (const addr of checksumed) {
    const m = metadataMap.get(addr)
    response[addr] = m && matchesProduct(m) ? m : null
  }
  return response
})
