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
import { toFunctionSignature } from 'viem'
import type { AbiFunction } from 'viem'
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

// Admission check guarding the long stale window: only an ABI the runtime
// consumers can actually encode against may overwrite the last-known-good
// entry. Item shape alone is not enough — a function fragment carrying the
// right name but missing `inputs` makes viem derive a wrong selector and
// emit garbage calldata — so each contract pins the canonical signatures
// (name + inputs, exactly what selector encoding depends on) its consumers
// call. Outputs are deliberately unpinned: return-tuple drift is the reason
// ABIs are resolved at runtime instead of compiled in.
const REQUIRED_ABI_SIGNATURES: Record<AbiContract, readonly string[]> = {
  // SDK account adapter / simulate / rewards (resolveAccountLensAbi)
  AccountLens: [
    'getEVCAccountInfo(address,address)',
    'getVaultAccountInfo(address,address)',
  ],
  // VaultOverviewBlockIRM computeAPYs read
  UtilsLens: ['computeAPYs(uint256,uint256,uint256,uint256)'],
  // Projected rates (utils/vault/apy.ts) and IRM overview
  VaultLens: ['getVaultInterestRateModelInfo(address,uint256[],uint256[])'],
}

const isValidAbiItem = (item: unknown): boolean => {
  if (item === null || typeof item !== 'object') return false
  const { type, name, inputs, outputs, stateMutability } = item as Record<string, unknown>
  if (typeof type !== 'string') return false
  if (type !== 'function') return true

  return typeof name === 'string'
    && Array.isArray(inputs)
    && Array.isArray(outputs)
    && typeof stateMutability === 'string'
}

const abiSignatures = (data: unknown[]): Set<string> => {
  const signatures = new Set<string>()
  for (const item of data) {
    if ((item as { type?: unknown }).type !== 'function') continue
    try {
      signatures.add(toFunctionSignature(item as AbiFunction))
    }
    catch {
      // A fragment viem cannot canonicalize cannot be encoded against
      // either — skip it; the required-signature check below decides.
    }
  }
  return signatures
}

const isValidAbi = (contract: AbiContract, data: unknown): data is unknown[] => {
  if (!Array.isArray(data) || data.length === 0) return false
  if (!data.every(isValidAbiItem)) return false

  const signatures = abiSignatures(data)
  return REQUIRED_ABI_SIGNATURES[contract].every(signature => signatures.has(signature))
}

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
    if (!isValidAbi(contract, data)) {
      throw new Error('Upstream returned an invalid ABI payload')
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
