import { createError, getHeader, getQuery, setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import {
  getCachedPublicLabelsBundle,
  getPublicLabelsBundle,
  refreshPublicLabelsBundle,
} from '~/server/utils/public-labels-source'
import { isV3LabelsVersionSelector } from '~/server/utils/labels-base-url'
import { isInternalRequest } from '~/server/utils/internal-headers'
import { resolveRpcUrl } from '~/server/utils/rpc'
import { LabelsConfigurationError } from '~/server/utils/labels-configuration-error'
import { logger } from '~/server/utils/logger'

/** A forced refresh is honoured once per window per chain; the warm cycle already refreshes every five minutes. */
const FORCED_REFRESH_MIN_INTERVAL_MS = 30_000

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'public-labels',
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

  let version: string | undefined
  if (query.version !== undefined) {
    if (typeof query.version !== 'string' || !isV3LabelsVersionSelector(query.version)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid labels version' })
    }
    if (!isInternalRequest(event)) {
      throw createError({ statusCode: 400, statusMessage: 'Labels version selection is internal' })
    }
    version = query.version
  }

  try {
    const cached = getCachedPublicLabelsBundle(chainId, version)
    const recentlyRefreshed = cached?.source !== 'static' && typeof cached?.sourceFetchedAt === 'number'
      && Date.now() - cached.sourceFetchedAt < FORCED_REFRESH_MIN_INTERVAL_MS
    const forceRefresh = getHeader(event, 'cache-control')?.toLowerCase().includes('no-cache') === true && !recentlyRefreshed
    const bundle = await (forceRefresh ? refreshPublicLabelsBundle(chainId, version) : getPublicLabelsBundle(chainId, version))
    setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')
    return bundle
  }
  catch (error) {
    setResponseHeader(event, 'Cache-Control', 'no-store')
    if (error instanceof LabelsConfigurationError) {
      logger.error({ ctx: 'public-labels', chainId, message: error.message }, 'Invalid labels configuration')
      throw createError({
        statusCode: 503,
        statusMessage: 'Labels configuration error',
        data: { code: 'LABELS_CONFIGURATION_ERROR', message: error.message },
      })
    }
    throw error
  }
})
