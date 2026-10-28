import { createError, getQuery, setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { logger } from '~/server/utils/logger'
import {
  buildPythProxyRequestHeaders,
  isPythProxyConfigured,
  PYTH_HERMES_URL,
} from '~/server/utils/pyth-proxy'

const FEED_ID_RE = /^0x[0-9a-fA-F]{64}$/

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'pyth-updates',
})

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  if (!isPythProxyConfigured()) {
    throw createError({ statusCode: 503, statusMessage: 'Pyth API key not configured' })
  }

  const query = getQuery(event)

  const rawIds = query['ids[]']
  const ids: string[] = Array.isArray(rawIds) ? rawIds.map(String) : rawIds ? [String(rawIds)] : []

  if (ids.length === 0) {
    throw createError({ statusCode: 400, statusMessage: 'Missing ids[] parameter' })
  }

  if (ids.length > 100) {
    throw createError({ statusCode: 400, statusMessage: 'Too many feed IDs' })
  }

  for (const id of ids) {
    if (!FEED_ID_RE.test(id)) {
      throw createError({ statusCode: 400, statusMessage: 'Invalid feed ID format' })
    }
  }

  const url = new URL('/v2/updates/price/latest', PYTH_HERMES_URL)
  ids.forEach(id => url.searchParams.append('ids[]', id))

  const encoding = String(query.encoding || 'hex')
  if (encoding === 'hex' || encoding === 'base64') {
    url.searchParams.set('encoding', encoding)
  }

  if (query.parsed === 'true') {
    url.searchParams.set('parsed', 'true')
  }

  try {
    const resp = await fetchWithTimeout(url.toString(), undefined, {
      headers: buildPythProxyRequestHeaders(),
    })
    setResponseHeader(event, 'Cache-Control', 'no-store')

    // Hermes returns 404 with a body listing the missing feed IDs when some
    // (but not all) IDs are unknown — the SDK parses that body to retry with
    // the remaining IDs. Forward 4xx responses verbatim so the SDK keeps its
    // recovery path; only synthesize an error for 5xx / network failures.
    if (!resp.ok && resp.status >= 500) {
      throw createError({ statusCode: 502, statusMessage: `Hermes returned ${resp.status}` })
    }

    event.node.res.statusCode = resp.status
    const contentType = resp.headers.get('content-type')
    if (contentType) setResponseHeader(event, 'Content-Type', contentType)
    return await resp.text()
  }
  catch (err) {
    if ((err as Record<string, unknown>).statusCode) throw err
    logger.warn({ ctx: 'pyth-updates', err }, 'failed to fetch from Pyth Hermes')
    throw createError({ statusCode: 502, statusMessage: 'Failed to fetch from Pyth Hermes' })
  }
})
