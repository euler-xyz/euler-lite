/**
 * Same-origin proxy for the runtime ABI documents the SDK's `ABIService`
 * would otherwise fetch from raw.githubusercontent.com in the browser
 * (see the `setQueryABI` wiring in composables/useEulerSdk.ts). ABIs are
 * resolved from euler-interfaces at runtime — rather than compiled in — so
 * a redeployed lens with a changed return tuple keeps decoding correctly;
 * this endpoint keeps that property while adding the same cache + stale +
 * snapshot resilience chain as /api/internal/euler-chains.
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
import accountLensSnapshot from '~/server/assets/manifests/abis/AccountLens.json'
import utilsLensSnapshot from '~/server/assets/manifests/abis/UtilsLens.json'
import vaultLensSnapshot from '~/server/assets/manifests/abis/VaultLens.json'

const CACHE_TTL_MS = 300_000

/**
 * The only ABIs fetched at runtime: AccountLens by the SDK's account
 * adapter / simulate / rewards paths, VaultLens and UtilsLens by the
 * projected-rates and IRM-overview features. Extend the list (and add a
 * snapshot to scripts/update-manifest-snapshots.mjs) when a new runtime
 * ABI consumer appears — unknown contracts 404 so the miss is loud.
 */
const ABI_SNAPSHOTS = {
  AccountLens: accountLensSnapshot,
  UtilsLens: utilsLensSnapshot,
  VaultLens: vaultLensSnapshot,
} as const

export type AbiContract = keyof typeof ABI_SNAPSHOTS
export const ABI_CONTRACTS = Object.keys(ABI_SNAPSHOTS) as AbiContract[]

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
  Object.prototype.hasOwnProperty.call(ABI_SNAPSHOTS, value)

/** Forced upstream refresh used by the warm-cache plugin; see euler-chains. */
export function refreshAbi(contract: AbiContract): Promise<unknown[]> {
  return inFlight.run(contract, async () => {
    const resp = await fetchWithTimeout(eulerInterfacesRawUrl(`abis/${contract}.json`))
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

/** Fresh cache → upstream → stale cache → build-time snapshot. */
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
      'no cached ABI; serving build-time snapshot',
    )
    return ABI_SNAPSHOTS[contract]
  }
}

export default defineEventHandler(async (event) => {
  rateLimiter.consume(event)

  const contract = getRouterParam(event, 'contract')
  if (!contract || !isAbiContract(contract)) {
    throw createError({ statusCode: 404, statusMessage: 'Unknown ABI contract' })
  }

  setResponseHeader(event, 'Cache-Control', 'public, max-age=300, stale-while-revalidate=600')

  return loadAbi(contract)
})
