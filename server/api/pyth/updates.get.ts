import { createError, getQuery, setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { logger } from '~/utils/logger'

const FEED_ID_RE = /^0x[0-9a-fA-F]{64}$/

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'pyth-updates',
})

function getHermesUrl(): string {
  return (process.env.PYTH_HERMES_URL || process.env.NUXT_PUBLIC_PYTH_HERMES_URL || '').replace(/\/+$/, '')
}

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const hermesUrl = getHermesUrl()
  if (!hermesUrl) {
    throw createError({ statusCode: 503, statusMessage: 'Pyth Hermes endpoint not configured' })
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

  const url = new URL(`${hermesUrl}/v2/updates/price/latest`)
  ids.forEach(id => url.searchParams.append('ids[]', id))

  const encoding = String(query.encoding || 'hex')
  if (encoding === 'hex' || encoding === 'base64') {
    url.searchParams.set('encoding', encoding)
  }

  if (query.parsed === 'true') {
    url.searchParams.set('parsed', 'true')
  }

  try {
    const resp = await fetchWithTimeout(url.toString())
    if (!resp.ok) {
      throw createError({ statusCode: resp.status, statusMessage: `Hermes returned ${resp.status}` })
    }

    setResponseHeader(event, 'Cache-Control', 'no-store')

    return await resp.json()
  }
  catch (err) {
    if ((err as Record<string, unknown>).statusCode) throw err
    logger.warn({ ctx: 'pyth-updates', err }, 'failed to fetch from Pyth Hermes')
    throw createError({ statusCode: 502, statusMessage: 'Failed to fetch from Pyth Hermes' })
  }
})
