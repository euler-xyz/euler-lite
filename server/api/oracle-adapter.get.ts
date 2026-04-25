import { createError, getQuery } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { createTtlCache } from '~/server/utils/cache'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { logger } from '~/utils/logger.server'
import { chainTag } from '~/utils/chain-tag'

const CACHE_TTL_MS = 300_000
const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

const rateLimiter = createRateLimiter({
  max: 1000,
  windowMs: 60_000,
  label: 'oracle-adapter',
})

const cache = createTtlCache<unknown>({ ttlMs: CACHE_TTL_MS, maxEntries: 500 })

function getUpstreamUrl(chainId: number, address: string): string {
  const baseUrl = (process.env.NUXT_PUBLIC_CONFIG_ORACLE_CHECKS_BASE_URL || '').trim().replace(/\/+$/, '')
  if (baseUrl) {
    return `${baseUrl}/${chainId}/adapters/${address}.json`
  }

  const repo = process.env.NUXT_PUBLIC_CONFIG_ORACLE_CHECKS_REPO || 'euler-xyz/oracle-checks'
  return `https://raw.githubusercontent.com/${repo}/refs/heads/master/data/${chainId}/adapters/${address}.json`
}

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const query = getQuery(event)
  const chainId = Number(query.chainId)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid chainId' })
  }

  const address = String(query.address || '')
  if (!ADDRESS_RE.test(address)) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid address' })
  }

  const key = `${chainId}:${address.toLowerCase()}`

  // No Cache-Control on this lazy (non-warm-cached) endpoint: origin data
  // age can already reach the full TTL between client probes, so any CDN
  // window would extend staleness past the per-cache invariant.

  const cached = cache.get(key)
  if (cached !== undefined) return cached

  try {
    const resp = await fetchWithTimeout(getUpstreamUrl(chainId, address))
    if (!resp.ok) {
      if (resp.status === 404) {
        cache.set(key, null)
        return null
      }
      throw new Error(`Upstream returned ${resp.status}`)
    }

    const data: unknown = await resp.json()
    cache.set(key, data)
    return data
  }
  catch (err) {
    logger.warn({ ctx: 'oracle-adapter', ...chainTag(chainId), address, err }, 'failed to fetch oracle adapter')

    const stale = cache.getStale(key)
    if (stale !== undefined) return stale

    return null
  }
})
