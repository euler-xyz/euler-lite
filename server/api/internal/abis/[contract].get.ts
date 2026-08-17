/**
 * Same-origin proxy for the runtime ABI documents the SDK's `ABIService`
 * would otherwise fetch from raw.githubusercontent.com in the browser
 * (see the `setQueryABI` wiring in composables/useEulerSdk.ts). ABIs are
 * resolved from euler-interfaces at runtime — rather than compiled in — so
 * a redeployed lens with a changed return tuple keeps decoding correctly;
 * this endpoint keeps that property while adding the same cache +
 * stale-fallback resilience chain as /api/internal/euler-chains.
 */
import { createError, getRouterParam, setResponseHeader } from 'h3'
import { createRateLimiter } from '~/server/utils/rate-limit'
import { createTtlCache } from '~/server/utils/cache'
import { fetchWithTimeout } from '~/server/utils/fetchWithTimeout'
import { createInFlightDedup } from '~/server/utils/in-flight'
import {
  MANIFEST_MAX_STALE_MS,
  eulerInterfacesRawUrl,
} from '~/server/utils/euler-interfaces'
import { logger } from '~/server/utils/logger'

const CACHE_TTL_MS = 300_000

/**
 * The only ABIs fetched at runtime: AccountLens by the SDK's account
 * adapter / simulate / rewards paths, VaultLens and UtilsLens by the
 * projected-rates and IRM-overview features. Extend the list when a new
 * runtime ABI consumer appears — unknown contracts 404 so the miss is loud.
 */
export const ABI_CONTRACTS = ['AccountLens', 'UtilsLens', 'VaultLens'] as const

export type AbiContract = (typeof ABI_CONTRACTS)[number]

const rateLimiter = createRateLimiter({
  max: 300,
  windowMs: 60_000,
  label: 'abis',
})

const cache = createTtlCache<unknown[]>({
  ttlMs: CACHE_TTL_MS,
  maxStaleMs: MANIFEST_MAX_STALE_MS,
  maxEntries: ABI_CONTRACTS.length,
})
const inFlight = createInFlightDedup<string, unknown[]>()

const isAbiContract = (value: string): value is AbiContract =>
  (ABI_CONTRACTS as readonly string[]).includes(value)

function getUpstreamUrl(contract: AbiContract): string {
  // An explicit base URL wins over the branch env vars — the same emergency
  // repoint lever as NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL. Must serve
  // `${baseUrl}/${contract}.json`.
  const baseUrl = (process.env.NUXT_PUBLIC_CONFIG_EULER_ABIS_BASE_URL || '').trim().replace(/\/+$/, '')
  if (baseUrl) return `${baseUrl}/${contract}.json`

  return eulerInterfacesRawUrl(`abis/${contract}.json`)
}

/** Forced upstream refresh used by the warm-cache plugin; see euler-chains. */
export function refreshAbi(contract: AbiContract): Promise<unknown[]> {
  return inFlight.run(contract, async () => {
    const resp = await fetchWithTimeout(getUpstreamUrl(contract))
    if (!resp.ok) {
      throw new Error(`Upstream returned ${resp.status}`)
    }

    const data: unknown = await resp.json()
    if (!Array.isArray(data)) {
      throw new Error('Upstream returned a non-array payload')
    }
    cache.set(contract, data)
    return data
  })
}

/**
 * Fresh cache → upstream → stale cache (long manifest window). Throws when
 * upstream is down and nothing was cached within the window; the SDK's
 * AccountLens path degrades to its bundled ABI, app features surface the
 * error.
 */
export async function loadAbi(contract: AbiContract): Promise<unknown[]> {
  const cached = cache.get(contract)
  if (cached) return cached

  try {
    return await refreshAbi(contract)
  }
  catch (err) {
    logger.warn({ ctx: 'abis', contract, err }, 'upstream fetch failed')

    const stale = cache.getStale(contract)
    if (stale) return stale

    logger.error(
      { ctx: 'abis', contract },
      'upstream unavailable and no cached ABI to serve',
    )
    throw err
  }
}

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const contract = getRouterParam(event, 'contract')
  if (!contract || !isAbiContract(contract)) {
    throw createError({ statusCode: 404, statusMessage: 'Unknown ABI contract' })
  }

  setResponseHeader(event, 'Cache-Control', 'public, max-age=300, stale-while-revalidate=600')

  try {
    return await loadAbi(contract)
  }
  catch {
    throw createError({ statusCode: 502, statusMessage: 'Upstream error' })
  }
})
