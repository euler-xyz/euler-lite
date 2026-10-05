import { createError, getRouterParam, setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { getCuratorProfile } from '~/server/utils/curator-profile-source'
import { logger } from '~/server/utils/logger'

const rateLimiter = createRateLimiter({
  max: 120,
  windowMs: 60_000,
  label: 'curator-profiles',
})

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)
  const entityId = getRouterParam(event, 'entityId') ?? ''
  if (!/^[A-Za-z0-9_-]{1,100}$/.test(entityId)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid entity ID' })
  }

  try {
    const profile = await getCuratorProfile(entityId)
    setResponseHeader(event, 'Cache-Control', 'public, max-age=60, stale-while-revalidate=60')
    return profile
  }
  catch (error) {
    logger.warn({ ctx: 'curator-profiles', entityId, err: error }, 'profile unavailable')
    throw createError({ statusCode: 502, statusMessage: 'Curator profile unavailable' })
  }
})
