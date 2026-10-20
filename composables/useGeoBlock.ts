import { detectCountry } from '~/services/country'
import {
  getVaultBlock,
  getEarnVaultBlock,
  getVaultRestricted,
  getEarnVaultRestricted,
  getAssetBlock,
  getAssetRestricted,
  getAssetPatternRules,
  isVaultDeprecated,
  patternRuleMatches,
  isWrapPair,
} from '~/utils/eulerLabelsUtils'
import { matchesHostedGeo } from '~/utils/geo-policies'
import { getEulerGeoContext, getEulerLabelsVersion } from '~/composables/useEulerLabels'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import { SANCTIONED_COUNTRIES, COUNTRY_GROUPS } from '~/entities/constants'

// undefined = not yet loaded, null = loaded but country unknown, string = loaded with country
const country = ref<string | null | undefined>(undefined)
let loadingCountry = false

export const useGeoBlock = () => {
  const loadCountry = async () => {
    if (!import.meta.client || loadingCountry) return
    loadingCountry = true
    try {
      const detected = await detectCountry()
      country.value = detected ?? null
    }
    catch {
      country.value = null
    }
    finally {
      loadingCountry = false
    }
  }

  const isPolicyAvailable = computed(() => {
    const hosted = getEulerGeoContext()
    return !hosted || hosted.policies !== undefined
  })
  return { country, loadCountry, isPolicyAvailable }
}

const isCountryInList = (codes: readonly string[]): boolean => {
  return codes.some(code => code.toUpperCase() === country.value!.toUpperCase())
}

const expandBlockList = (codes: readonly string[]): string[] => {
  return codes.flatMap(code => COUNTRY_GROUPS[code] ?? [code])
}

/**
 * Asset reference accepted by the asset-level geo helpers.
 * - A plain address string keeps backward compatibility with callers that
 *   only know the address; pattern rules (symbol/name) can't be consulted.
 * - An asset-like object (VaultAsset or any subset) unlocks symbol/name
 *   pattern matching in addition to the address lookup.
 */
export type AssetLike = string | { address?: string, symbol?: string, name?: string } | undefined

/** Resolved SDK vaults carry the chain that gives their asset metadata meaning. */
export type VaultGeoInput = string | { address: string, chainId: number, asset?: AssetLike }
export type VaultGeoBlockReason = 'region' | 'country-unavailable' | 'policy-unavailable' | 'asset-unavailable' | 'chain-mismatch'

export interface VaultGeoPolicyOptions {
  /** Prefer the caller's already-resolved, chain-scoped vault asset. */
  asset?: AssetLike
  /** Asset on the other side of a wrap/acquisition check. */
  counterpart?: AssetLike
}

// Normalize an AssetLike into the three fields we consult. Returns undefined
// when nothing is available (keeps callers' guards simple).
const toAssetFields = (asset: AssetLike): { address?: string, symbol?: string, name?: string } | undefined => {
  if (asset === undefined) return undefined
  if (typeof asset === 'string') return asset ? { address: asset } : undefined
  if (!asset.address && !asset.symbol && !asset.name) return undefined
  return {
    address: asset.address,
    symbol: asset.symbol,
    name: asset.name,
  }
}

// Per-country cache for asset-level block / restricted resolution. Browse
// pages call these helpers per-row for potentially hundreds of rows on each
// render; the pattern-rule scan is O(rules) which adds up. Cache key
// composes country + address + symbol + name so a country change (rare) or
// a new unique asset produces a fresh entry without ever serving stale data.
// Pattern-rule content comes from the current SDK labels snapshot. Include the
// labels version in the key so a refreshed snapshot cannot reuse old decisions.
const MAX_ASSET_CACHE_SIZE = 1000
const assetBlockCache = new Map<string, boolean>()
const assetRestrictedCache = new Map<string, boolean>()

const makeAssetCacheKey = (fields: { address?: string, symbol?: string, name?: string }): string =>
  `${getEulerLabelsVersion()}|${country.value ?? ''}|${fields.address?.toLowerCase() ?? ''}|${fields.symbol?.toLowerCase() ?? ''}|${fields.name?.toLowerCase() ?? ''}`

const cacheSet = (cache: Map<string, boolean>, key: string, value: boolean): boolean => {
  if (cache.size >= MAX_ASSET_CACHE_SIZE) cache.clear()
  cache.set(key, value)
  return value
}

export const clearAssetGeoCache = (): void => {
  assetBlockCache.clear()
  assetRestrictedCache.clear()
}

// Resolve the underlying asset for a vault via the registry.
// Used by vault-level helpers to OR-in asset-level rules from assets.json,
// including pattern rules against the asset's symbol and name.
//
// The registry accessor is resolved lazily on first use instead of at
// module-load time. Module-load destructuring against `useVaultRegistry()`
// triggered a TDZ error in some import orderings (auto-imports create
// cycles that we can't see at call sites). Lazy-once keeps the per-call
// allocation cost at zero after the first invocation without coupling
// to module-eval order.
let registryGetVault: ((addr: string) => ReturnType<ReturnType<typeof useVaultRegistry>['getVault']>) | null = null
const getVaultUnderlyingAsset = (vaultAddress: string): { address: string, symbol: string, name: string } | undefined => {
  if (!registryGetVault) {
    registryGetVault = useVaultRegistry().getVault
  }
  const asset = registryGetVault(vaultAddress)?.asset
  if (!asset) return undefined
  return { address: asset.address, symbol: asset.symbol, name: asset.name }
}

export const isAssetBlockedByCountry = (asset: AssetLike): boolean => {
  const fields = toAssetFields(asset)
  if (!fields) return false
  if (country.value === undefined) return true // unresolved policy must fail closed
  if (country.value === null) return true // loaded, country unknown
  const hostedContext = getEulerGeoContext()
  if (hostedContext && hostedContext.policies === undefined) return true

  const cacheKey = makeAssetCacheKey(fields)
  const cached = assetBlockCache.get(cacheKey)
  if (cached !== undefined) return cached

  // Sanctioned countries are always blocked
  if (isCountryInList(SANCTIONED_COUNTRIES)) return cacheSet(assetBlockCache, cacheKey, true)

  const hosted = getEulerGeoContext()
  if (hosted) return cacheSet(assetBlockCache, cacheKey, matchesHostedGeo(hosted, country.value, 'block', fields))

  if (fields.address) {
    const assetBlock = getAssetBlock(fields.address)
    if (assetBlock?.length && isCountryInList(expandBlockList(assetBlock))) {
      return cacheSet(assetBlockCache, cacheKey, true)
    }
  }

  // Pattern rules: only consulted when symbol or name is available. Callers
  // that pass a plain address skip this path (same as pre-PR behavior for
  // non-pattern rules).
  const symbolLower = fields.symbol?.toLowerCase()
  const nameLower = fields.name?.toLowerCase()
  if (symbolLower || nameLower) {
    for (const rule of getAssetPatternRules()) {
      if (!rule.block?.length) continue
      if (!patternRuleMatches(rule, symbolLower, nameLower)) continue
      if (isCountryInList(expandBlockList(rule.block))) {
        return cacheSet(assetBlockCache, cacheKey, true)
      }
    }
  }

  return cacheSet(assetBlockCache, cacheKey, false)
}

export const isAssetRestrictedByCountry = (
  asset: AssetLike,
  opts?: { counterpart?: AssetLike },
): boolean => {
  const hosted = getEulerGeoContext()
  if (hosted && hosted.policies === undefined) return true
  const fields = toAssetFields(asset)
  if (!fields) return false
  if (country.value === undefined) return true // unresolved policy must fail closed
  if (country.value === null) return true // loaded, country unknown

  // Global/chain rules cannot be exempted by a wrap or same-asset transfer.
  if (hosted && matchesHostedGeo(hosted, country.value, 'restrict', fields, undefined, 'non-asset')) return true

  const cacheKey = makeAssetCacheKey(fields)
  const cached = assetRestrictedCache.get(cacheKey)
  const restricted = cached !== undefined ? cached : computeAssetRestricted(fields, cacheKey)
  if (!restricted) return false

  if (opts?.counterpart) {
    const counterFields = toAssetFields(opts.counterpart)
    if (counterFields?.address && fields.address) {
      const aLower = fields.address.toLowerCase()
      const cLower = counterFields.address.toLowerCase()
      if (aLower === cLower) return false
      if (isWrapPair(aLower, cLower)) return false
    }
  }
  return true
}

const computeAssetRestricted = (
  fields: { address?: string, symbol?: string, name?: string },
  cacheKey: string,
): boolean => {
  const hosted = getEulerGeoContext()
  if (hosted) return cacheSet(assetRestrictedCache, cacheKey, matchesHostedGeo(hosted, country.value!, 'restrict', fields, undefined, 'asset'))

  if (fields.address) {
    const assetRestricted = getAssetRestricted(fields.address)
    if (assetRestricted?.length && isCountryInList(expandBlockList(assetRestricted))) {
      return cacheSet(assetRestrictedCache, cacheKey, true)
    }
  }

  const symbolLower = fields.symbol?.toLowerCase()
  const nameLower = fields.name?.toLowerCase()
  if (symbolLower || nameLower) {
    for (const rule of getAssetPatternRules()) {
      if (!rule.restricted?.length) continue
      if (!patternRuleMatches(rule, symbolLower, nameLower)) continue
      if (isCountryInList(expandBlockList(rule.restricted))) {
        return cacheSet(assetRestrictedCache, cacheKey, true)
      }
    }
  }

  return cacheSet(assetRestrictedCache, cacheKey, false)
}

const isStaleVaultGeoInput = (vault: VaultGeoInput): boolean => {
  const activeChainId = useEulerAddresses().chainId.value
  const hosted = getEulerGeoContext()
  return (typeof vault !== 'string' && vault.chainId !== activeChainId)
    || (hosted?.chainId != null && hosted.chainId !== activeChainId)
}

const resolveVaultGeoInput = (vault: VaultGeoInput, opts?: Pick<VaultGeoPolicyOptions, 'asset'>) => {
  const address = typeof vault === 'string' ? vault : vault.address
  const asset = opts?.asset ?? (typeof vault === 'string' ? undefined : vault.asset) ?? getVaultUnderlyingAsset(address)
  return { address, asset }
}

/** Only `region` is affirmative geographic evidence; other reasons describe missing context. */
export const getVaultGeoBlockReason = (
  vault: VaultGeoInput,
  opts?: Pick<VaultGeoPolicyOptions, 'asset'>,
): VaultGeoBlockReason | undefined => {
  if (country.value == null) return 'country-unavailable'
  if (isCountryInList(SANCTIONED_COUNTRIES)) return 'region'
  if (isStaleVaultGeoInput(vault)) return 'chain-mismatch'
  const { address, asset } = resolveVaultGeoInput(vault, opts)
  if (!address) return undefined

  const hosted = getEulerGeoContext()
  if (hosted) {
    if (hosted.policies === undefined) return 'policy-unavailable'
    const fields = toAssetFields(asset)
    if (matchesHostedGeo(hosted, country.value, 'block', fields, address)) return 'region'
    return fields ? undefined : 'asset-unavailable'
  }

  const productBlock = getVaultBlock(address)
  if (productBlock?.length && isCountryInList(expandBlockList(productBlock))) return 'region'
  const earnBlock = getEarnVaultBlock(address)
  if (earnBlock?.length && isCountryInList(expandBlockList(earnBlock))) return 'region'
  if (!toAssetFields(asset)) return 'asset-unavailable'
  return isAssetBlockedByCountry(asset) ? 'region' : undefined
}

/** Explain unavailable evidence without asserting that a geographic rule matched. */
export const getVaultGeoUnavailableReason = (...vaults: (VaultGeoInput | undefined)[]): string | undefined => {
  const reasons = vaults.filter(vault => vault !== undefined).map(vault => getVaultGeoBlockReason(vault))
  if (reasons.includes('region')) return undefined
  if (reasons.includes('country-unavailable')) return 'Your country could not be determined. Please retry.'
  if (reasons.includes('policy-unavailable')) return 'Compliance data unavailable. Please retry.'
  if (reasons.includes('chain-mismatch') || reasons.includes('asset-unavailable')) return 'Vault data is unavailable for this network. Please retry.'
  return undefined
}

export const isVaultBlockedByCountry = (
  vault: VaultGeoInput,
  opts?: Pick<VaultGeoPolicyOptions, 'asset'>,
): boolean => {
  const reason = getVaultGeoBlockReason(vault, opts)
  // Policy availability separately gates new exposure; preserve simple exits.
  return reason !== undefined && reason !== 'policy-unavailable'
}

export const isAnyVaultBlockedByCountry = (...vaults: (VaultGeoInput | undefined)[]): boolean => {
  return vaults.some(vault => vault !== undefined && isVaultBlockedByCountry(vault))
}

export const isVaultRestrictedByCountry = (
  vault: VaultGeoInput,
  opts?: VaultGeoPolicyOptions,
): boolean => {
  if (country.value === undefined) return true // unresolved policy must fail closed
  if (country.value === null) return true // loaded, country unknown
  if (isStaleVaultGeoInput(vault)) return true
  const { address: vaultAddress, asset: resolvedAsset } = resolveVaultGeoInput(vault, opts)
  if (!vaultAddress) return false

  const hosted = getEulerGeoContext()
  if (hosted) {
    if (hosted.policies === undefined) return true
    const asset = toAssetFields(resolvedAsset)
    if (matchesHostedGeo(hosted, country.value, 'restrict', asset, vaultAddress, 'non-asset')) return true
    if (!asset) return true
    if (!matchesHostedGeo(hosted, country.value, 'restrict', asset, vaultAddress, 'asset')) return false
    const counterpart = toAssetFields(opts?.counterpart)
    return !(asset.address && counterpart?.address
      && (asset.address.toLowerCase() === counterpart.address.toLowerCase() || isWrapPair(asset.address, counterpart.address)))
  }

  const vaultRestricted = getVaultRestricted(vaultAddress)
  if (vaultRestricted?.length && isCountryInList(expandBlockList(vaultRestricted))) return true

  const earnRestricted = getEarnVaultRestricted(vaultAddress)
  if (earnRestricted?.length && isCountryInList(expandBlockList(earnRestricted))) return true

  const asset = resolvedAsset
  if (!toAssetFields(asset)) return true
  if (isAssetRestrictedByCountry(asset, { counterpart: opts?.counterpart })) return true

  return false
}

export const isAnyVaultRestrictedByCountry = (...vaults: VaultGeoInput[]): boolean => {
  return vaults.some(vault => isVaultRestrictedByCountry(vault))
}

export type VaultTagContext = 'browse' | 'swap-target' | 'supply-source'

export const getVaultTags = (
  vaultAddress: VaultGeoInput,
  context: VaultTagContext = 'browse',
): { tags: string[], disabled: boolean } => {
  const tags: string[] = []
  const reason = getVaultGeoBlockReason(vaultAddress)
  const policyResolved = reason === undefined
  const blocked = reason !== undefined && reason !== 'policy-unavailable'
  const address = typeof vaultAddress === 'string' ? vaultAddress : vaultAddress.address
  const restricted = !blocked && isVaultRestrictedByCountry(vaultAddress)

  if (reason === 'region') tags.push('Restricted')
  // Soft-restricted: only show tag when the context involves acquiring more exposure
  if (restricted && context === 'swap-target' && policyResolved) tags.push('Restricted')
  if (isVaultDeprecated(address)) tags.push('Deprecated')

  const disabled = blocked
    || isVaultDeprecated(address)
    || (restricted && context === 'swap-target')

  return { tags, disabled }
}
