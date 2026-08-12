import { createError, getHeader, getQuery, setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import {
  getPublicLabelsBundle,
  refreshPublicLabelsBundle,
} from '~/server/utils/public-labels-source'
import { PUBLIC_LABELS_RUNTIME_VERSION } from '~/utils/public-labels'

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

  const version = typeof query.version === 'string' && query.version.length > 0
    ? query.version
    : PUBLIC_LABELS_RUNTIME_VERSION
  if (version !== PUBLIC_LABELS_RUNTIME_VERSION && !/^v[0-9]{17}$/.test(version)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid labels version' })
  }

  setResponseHeader(event, 'Cache-Control', 'public, max-age=30, stale-while-revalidate=30')
  const forceRefresh = getHeader(event, 'cache-control')?.toLowerCase().includes('no-cache') === true
  return forceRefresh
    ? refreshPublicLabelsBundle(chainId, version)
    : getPublicLabelsBundle(chainId, version)
})
