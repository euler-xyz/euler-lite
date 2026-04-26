import { createError, getQuery } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { createTtlCache } from '~/server/utils/cache'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { logWarn } from '~/server/utils/log'

const CACHE_TTL_MS = 300_000

const rateLimiter = createRateLimiter({
  max: 60,
  windowMs: 60_000,
  label: 'oracle-adapters',
})

const cache = createTtlCache<unknown>({ ttlMs: CACHE_TTL_MS, maxEntries: 50 })

function getUpstreamUrl(chainId: number): string {
  const baseUrl = (process.env.NUXT_PUBLIC_CONFIG_ORACLE_CHECKS_BASE_URL || '').trim().replace(/\/+$/, '')
  if (baseUrl) {
    return `${baseUrl}/${chainId}/adapters/all.json`
  }

  const repo = process.env.NUXT_PUBLIC_CONFIG_ORACLE_CHECKS_REPO || 'euler-xyz/oracle-checks'
  return `https://raw.githubusercontent.com/${repo}/refs/heads/master/data/${chainId}/adapters/all.json`
}

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const query = getQuery(event)
  const chainId = Number(query.chainId)
  if (!Number.isInteger(chainId) || chainId <= 0) {
    throw createError({ statusCode: 400, statusMessage: 'Invalid chainId' })
  }

  const key = `${chainId}`

  const cached = cache.get(key)
  if (cached !== undefined) return cached

  try {
    const resp = await fetchWithTimeout(getUpstreamUrl(chainId))
    if (!resp.ok) {
      // Don't cache the empty fallback for 404 (or any non-OK status). A
      // missing/transient upstream response would otherwise pin every client
      // to the empty array for the full TTL window — better to let the next
      // request retry quickly.
      if (resp.status === 404) return []
      throw new Error(`Upstream returned ${resp.status}`)
    }

    const data: unknown = await resp.json()
    cache.set(key, data)
    return data
  }
  catch (err) {
    logWarn('oracle-adapters', `Failed to fetch all.json for chain ${chainId}:`, err instanceof Error ? err.message : err)

    const stale = cache.getStale(key)
    if (stale !== undefined) return stale

    // Same reasoning as the 404 branch: don't pollute the cache with an empty
    // array on transient failures.
    return []
  }
})
