import { setResponseHeader } from 'h3'
import { getLiquidationCoverage } from '~/server/utils/liquidation-coverage-source'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { resolveChainId } from '~/server/utils/resolve-chain-id'

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'liquidation-coverage',
})

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)
  const chainId = resolveChainId(event, { requireEnabled: true })
  setResponseHeader(event, 'Cache-Control', 'public, max-age=60, stale-while-revalidate=60')
  return getLiquidationCoverage(chainId)
})
