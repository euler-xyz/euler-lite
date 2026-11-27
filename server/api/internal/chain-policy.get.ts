import { createError, setResponseHeader } from 'h3'
import { loadServerChainPolicy } from '~/server/utils/chain-policy'
import { resolveChainId } from '~/server/utils/resolve-chain-id'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { getChainReadPolicy, type ChainPolicyResponse } from '~/utils/chain-policy'

const rateLimiter = createRateLimiter({ max: 1000, windowMs: 60_000, label: 'chain-policy' })

export default defineEventHandler(async (event): Promise<ChainPolicyResponse> => {
  setResponseHeader(event, 'Cache-Control', 'no-store')
  rateLimiter.consume(event)
  const chainId = resolveChainId(event)
  const config = await loadServerChainPolicy()
  if (!config.enabledChainIds.includes(chainId)) {
    throw createError({ statusCode: 400, statusMessage: 'Unsupported chainId' })
  }
  return { chainId, policy: getChainReadPolicy(config, chainId) }
})
