import { defineEventHandler } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { createTtlCache } from '~/server/utils/cache'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { logger } from '~/server/utils/logger'
import { resolveChainId } from '~/server/utils/resolve-chain-id'

const CACHE_TTL_MS = 300_000

/**
 * Builds the upstream oracle-checks URL for a chain's resource. When
 * `address` is omitted, targets the warm-cached `all.json` list; otherwise
 * targets a single `<address>.json` entry. Honours the base-URL / repo env
 * overrides shared by every oracle-checks endpoint.
 */
export function oracleChecksUrl(chainId: number, resource: string, address?: string): string {
  const leaf = address ? `${address}.json` : 'all.json'
  const baseUrl = (process.env.NUXT_PUBLIC_CONFIG_ORACLE_CHECKS_BASE_URL || '').trim().replace(/\/+$/, '')
  if (baseUrl) {
    return `${baseUrl}/${chainId}/${resource}/${leaf}`
  }

  const repo = process.env.NUXT_PUBLIC_CONFIG_ORACLE_CHECKS_REPO || 'euler-xyz/oracle-checks'
  return `https://raw.githubusercontent.com/${repo}/refs/heads/master/data/${chainId}/${resource}/${leaf}`
}

/**
 * Builds a warm-cached oracle-checks list handler for a resource
 * (`routers` / `adapters`). Fetches `<chainId>/<resource>/all.json`, caches
 * successful responses, and falls back to a stale cache entry or empty array
 * on transient failures. 404s return an empty array without polluting the
 * cache.
 */
export function createOracleChecksHandler(options: {
  resource: string
  label: string
  max: number
  logMessage: string
}) {
  const { resource, label, max, logMessage } = options

  const rateLimiter = createRateLimiter({
    max,
    windowMs: 60_000,
    label,
  })

  const cache = createTtlCache<unknown>({ ttlMs: CACHE_TTL_MS, maxEntries: 50 })

  return defineEventHandler(async (event) => {
    rateLimiter.consume(event)

    const chainId = resolveChainId(event, { requireEnabled: false })

    const key = `${chainId}`

    const cached = cache.get(key)
    if (cached !== undefined) return cached

    try {
      const resp = await fetchWithTimeout(oracleChecksUrl(chainId, resource))
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
      logger.warn({ ctx: label, chainId, err }, logMessage)

      const stale = cache.getStale(key)
      if (stale !== undefined) return stale

      // Same reasoning as the 404 branch: don't pollute the cache with an empty
      // array on transient failures.
      return []
    }
  })
}
