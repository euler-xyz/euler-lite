import { createError, getRouterParam, setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { getCuratorNetworkIndex } from '~/server/utils/curator-network-index'
import { logger } from '~/server/utils/logger'

const rateLimiter = createRateLimiter({
  max: 120,
  windowMs: 60_000,
  label: 'curator-networks',
})

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)
  const entityId = getRouterParam(event, 'entityId') ?? ''
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(entityId)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid entity ID' })
  }

  try {
    const index = await getCuratorNetworkIndex(entityId)
    setResponseHeader(event, 'Cache-Control', 'public, max-age=60, stale-while-revalidate=60')
    return index
  }
  catch (error) {
    logger.warn({ ctx: 'curator-networks', entityId, err: error }, 'index unavailable')
    throw createError({ statusCode: 502, statusMessage: 'Curator networks unavailable' })
  }
})
