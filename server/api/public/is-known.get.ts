import { createError, getQuery } from 'h3'
import { getAddress, isAddress } from 'viem'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { resolveRpcUrl } from '~/server/utils/rpc'
import { getVerifiedAddressSet } from '~/server/utils/verified-vaults'
import { logWarn } from '~/server/utils/log'

const MAX_ADDRESSES = 100

const rateLimiter = createRateLimiter({
  max: 100,
  windowMs: 60_000,
  label: 'public-is-known',
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

  const raw = typeof query.addresses === 'string' ? query.addresses : ''
  const parts = raw.split(',').map(s => s.trim()).filter(Boolean)
  if (parts.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Missing addresses' })
  }
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

  let verifiedSet: Set<string>
  try {
    verifiedSet = await getVerifiedAddressSet(chainId)
  }
  catch (err) {
    logWarn('public-is-known', `lookup failed for chain ${chainId}:`, err instanceof Error ? err.message : err)
    throw createError({ statusCode: 502, statusMessage: 'Upstream error' })
  }

  const response: Record<string, boolean> = {}
  for (const addr of checksumed) {
    response[addr] = verifiedSet.has(addr)
  }
  return response
})
