import { createError, getQuery } from 'h3'
import { getAddress, isAddress } from 'viem'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { resolveRpcUrl } from '~/server/utils/rpc'
import { getChainVaultMetadata, type VaultMetadata } from '~/server/utils/vault-metadata'
import { logger } from '~/server/utils/logger'

const MAX_ADDRESSES = 100

const rateLimiter = createRateLimiter({
  max: 100,
  windowMs: 60_000,
  label: 'public-vault-metadata',
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

  let metadataMap: Map<string, VaultMetadata>
  try {
    metadataMap = await getChainVaultMetadata(chainId)
  }
  catch (err) {
    logger.warn({ ctx: 'public-vault-metadata', chainId, err }, 'metadata lookup failed')
    throw createError({ statusCode: 502, statusMessage: 'Upstream error' })
  }

  // No addresses supplied → list mode: emit the full known set.
  if (checksumed.length === 0) {
    return Object.fromEntries(metadataMap)
  }

  const response: Record<string, VaultMetadata | null> = {}
  for (const addr of checksumed) {
    response[addr] = metadataMap.get(addr) ?? null
  }
  return response
})
