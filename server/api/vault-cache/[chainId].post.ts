import { createError, readBody } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { vaultHexCache, vaultCacheKey } from '~/server/utils/vault-cache-store'

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'vault-cache',
})

export default defineEventHandler(async (event) => {
  const chainId = Number(event.context.params?.chainId)

  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid chainId' })
  }

  rateLimiter.consume(event)

  const body = await readBody(event)
  const vaults: unknown = body?.vaults

  if (!Array.isArray(vaults) || vaults.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'vaults must be a non-empty array' })
  }

  vaultHexCache.deleteExpired()

  const result: Record<string, string> = {}

  for (const vaultAddress of vaults) {
    if (typeof vaultAddress !== 'string') continue
    const hex = vaultHexCache.get(vaultCacheKey(chainId, vaultAddress))
    if (hex) result[vaultAddress] = hex
  }

  return result
})
