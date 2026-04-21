import { createError, readBody } from 'h3'
import { isAddress } from 'viem'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { getEnabledChainIds } from '~/utils/chain-env'
import { logWarn } from '~/server/utils/log'
import { getVaultFactories } from '~/server/utils/vault-factories-store'

const MAX_ADDRESSES_PER_REQUEST = 1000

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'vault-factories',
})

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const body = await readBody<{ chainId?: unknown, addresses?: unknown }>(event)
  const chainId = Number(body?.chainId)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid chainId' })
  }
  if (!getEnabledChainIds().includes(chainId)) {
    throw createError({ statusCode: 400, statusMessage: 'Unsupported chainId' })
  }

  if (!Array.isArray(body?.addresses) || body.addresses.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'addresses must be a non-empty array' })
  }
  if (body.addresses.length > MAX_ADDRESSES_PER_REQUEST) {
    throw createError({ statusCode: 400, statusMessage: `addresses exceeds max of ${MAX_ADDRESSES_PER_REQUEST}` })
  }
  for (const addr of body.addresses) {
    if (typeof addr !== 'string' || !isAddress(addr)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid address in list' })
    }
  }

  try {
    const factories = await getVaultFactories(chainId, body.addresses as string[])
    return { factories }
  }
  catch (err) {
    logWarn('vault-factories', `Subgraph query failed for chain ${chainId}:`, err instanceof Error ? err.message : err)
    return { factories: {} }
  }
})
