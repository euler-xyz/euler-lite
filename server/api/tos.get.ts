import { createError } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { createTtlCache } from '~/server/utils/cache'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { logger } from '~/utils/logger'

const CACHE_TTL_MS = 300_000

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'tos',
})

const cache = createTtlCache<string>({ ttlMs: CACHE_TTL_MS })

function getUpstreamUrl(): string {
  return (process.env.NUXT_PUBLIC_CONFIG_TOS_MD_URL || '').trim()
}

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const upstreamUrl = getUpstreamUrl()
  if (!upstreamUrl) {
    throw createError({ statusCode: 404, statusMessage: 'TOS not configured' })
  }

  const cached = cache.get('tos')
  if (cached) return cached

  try {
    const resp = await fetchWithTimeout(upstreamUrl)
    if (!resp.ok) {
      throw new Error(`Upstream returned ${resp.status}`)
    }

    const text = await resp.text()
    cache.set('tos', text)
    return text
  }
  catch (err) {
    logger.warn({ ctx: 'tos', err }, 'upstream fetch failed')

    const stale = cache.getStale('tos')
    if (stale) return stale

    throw createError({ statusCode: 502, statusMessage: 'Upstream error' })
  }
})
