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

  const version = typeof query.version === 'string' && query.version.length > 0
    ? query.version
    : undefined
  if (version !== undefined && !isV3LabelsVersionSelector(version)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid labels version' })
  }
  if (version !== undefined && !isInternalRequest(event)) {
    throw createError({ statusCode: 400, statusMessage: 'Labels version selection is internal' })
  }

  setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')
  const cached = getCachedPublicLabelsBundle(chainId, version)
  const recentlyRefreshed = cached?.source !== 'static' && typeof cached?.sourceFetchedAt === 'number'
    && Date.now() - cached.sourceFetchedAt < FORCED_REFRESH_MIN_INTERVAL_MS
  const forceRefresh = getHeader(event, 'cache-control')?.toLowerCase().includes('no-cache') === true && !recentlyRefreshed
  return forceRefresh
    ? refreshPublicLabelsBundle(chainId, version)
    : getPublicLabelsBundle(chainId, version)
})
