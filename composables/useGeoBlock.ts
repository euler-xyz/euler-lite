import { detectCountry } from '~/services/country'
import {
  getVaultBlock,
  getEarnVaultBlock,
  getVaultRestricted,
  getEarnVaultRestricted,
  getAssetBlock,
  getAssetRestricted,
  isVaultDeprecated,
} from '~/utils/eulerLabelsUtils'
import { assetPatternRules, type CompiledPatternRule } from '~/utils/eulerLabelsState'
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

  return { country, loadCountry }
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

// Cap inputs passed to regex .test() to protect against catastrophic
// backtracking if a curator ships a poorly-formed pattern and an on-chain
// token returns an attacker-chosen long symbol/name. Real ERC-20 symbols are
// typically <=12 chars and names <=64; 128 is well above any legitimate value.
const MAX_REGEX_INPUT_LEN = 128

// Per-country cache for asset-level block / restricted resolution. Browse
// pages call these helpers per-row for potentially hundreds of rows on each
// render; the pattern-rule scan is O(rules) which adds up. Cache key
// composes country + address + symbol + name so a country change (rare) or
// a new unique asset produces a fresh entry without ever serving stale data.
// Pattern-rule content lives in module-scoped `assetPatternRules`; the
// labels loader calls `clearAssetGeoCache()` after repopulating that list
// so we never serve a decision computed against removed rules.
const MAX_ASSET_CACHE_SIZE = 1000
const assetBlockCache = new Map<string, boolean>()
const assetRestrictedCache = new Map<string, boolean>()

const makeAssetCacheKey = (fields: { address?: string, symbol?: string, name?: string }): string =>
  `${country.value ?? ''}|${fields.address?.toLowerCase() ?? ''}|${fields.symbol?.toLowerCase() ?? ''}|${fields.name?.toLowerCase() ?? ''}`

const cacheSet = (cache: Map<string, boolean>, key: string, value: boolean): boolean => {
  if (cache.size >= MAX_ASSET_CACHE_SIZE) cache.clear()
  cache.set(key, value)
  return value
}

export const clearAssetGeoCache = (): void => {
  assetBlockCache.clear()
  assetRestrictedCache.clear()
}

// Test whether a pattern rule matches the given symbol/name (lowercase inputs).
// OR across populated fields — any match wins.
const patternRuleMatches = (rule: CompiledPatternRule, symbolLower: string | undefined, nameLower: string | undefined): boolean => {
  if (rule.symbolsLower && symbolLower && rule.symbolsLower.has(symbolLower)) return true
  if (rule.symbolRegex && symbolLower && symbolLower.length <= MAX_REGEX_INPUT_LEN && rule.symbolRegex.test(symbolLower)) return true
  if (rule.namesLower && nameLower && rule.namesLower.has(nameLower)) return true
  if (rule.nameRegex && nameLower && nameLower.length <= MAX_REGEX_INPUT_LEN && rule.nameRegex.test(nameLower)) return true
  return false
}

// Module-scoped accessor: useVaultRegistry() returns module-level state,
// but instantiating the wrapper per call allocates a new object on every
// vault render in browse tables. Resolve it once at module load.
const { getVault: registryGetVault } = useVaultRegistry()

// Resolve the underlying asset for a vault via the registry.
// Used by vault-level helpers to OR-in asset-level rules from assets.json,
// including pattern rules against the asset's symbol and name.
const getVaultUnderlyingAsset = (vaultAddress: string): { address: string, symbol: string, name: string } | undefined => {
  const asset = registryGetVault(vaultAddress)?.asset
  if (!asset) return undefined
  return { address: asset.address, symbol: asset.symbol, name: asset.name }
}

export const isAssetBlockedByCountry = (asset: AssetLike): boolean => {
  const fields = toAssetFields(asset)
  if (!fields) return false
  if (country.value === undefined) return false // still loading
  if (country.value === null) return true // loaded, country unknown

  const cacheKey = makeAssetCacheKey(fields)
  const cached = assetBlockCache.get(cacheKey)
  if (cached !== undefined) return cached

  // Sanctioned countries are always blocked
  if (isCountryInList(SANCTIONED_COUNTRIES)) return cacheSet(assetBlockCache, cacheKey, true)

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
    for (const rule of assetPatternRules) {
      if (!rule.block?.length) continue
      if (!patternRuleMatches(rule, symbolLower, nameLower)) continue
      if (isCountryInList(expandBlockList(rule.block))) {
        return cacheSet(assetBlockCache, cacheKey, true)
      }
    }
  }

  return cacheSet(assetBlockCache, cacheKey, false)
}

export const isAssetRestrictedByCountry = (asset: AssetLike): boolean => {
  const fields = toAssetFields(asset)
  if (!fields) return false
  if (country.value === undefined) return false // still loading
  if (country.value === null) return true // loaded, country unknown

  const cacheKey = makeAssetCacheKey(fields)
  const cached = assetRestrictedCache.get(cacheKey)
  if (cached !== undefined) return cached

  if (fields.address) {
    const assetRestricted = getAssetRestricted(fields.address)
    if (assetRestricted?.length && isCountryInList(expandBlockList(assetRestricted))) {
      return cacheSet(assetRestrictedCache, cacheKey, true)
    }
  }

  const symbolLower = fields.symbol?.toLowerCase()
  const nameLower = fields.name?.toLowerCase()
  if (symbolLower || nameLower) {
    for (const rule of assetPatternRules) {
      if (!rule.restricted?.length) continue
      if (!patternRuleMatches(rule, symbolLower, nameLower)) continue
      if (isCountryInList(expandBlockList(rule.restricted))) {
        return cacheSet(assetRestrictedCache, cacheKey, true)
      }
    }
  }

  return cacheSet(assetRestrictedCache, cacheKey, false)
}

export const isVaultBlockedByCountry = (vaultAddress: string): boolean => {
  if (country.value === undefined) return false // still loading
  if (country.value === null) return true // loaded, country unknown

  // Sanctioned countries are always blocked
  if (isCountryInList(SANCTIONED_COUNTRIES)) return true

  const productBlock = getVaultBlock(vaultAddress)
  if (productBlock?.length && isCountryInList(expandBlockList(productBlock))) return true

  const earnBlock = getEarnVaultBlock(vaultAddress)
  if (earnBlock?.length && isCountryInList(expandBlockList(earnBlock))) return true

  // Asset-level block: a vault is blocked whenever its underlying asset is blocked.
  // Pass the full asset so pattern rules (symbol/name) also apply.
  if (isAssetBlockedByCountry(getVaultUnderlyingAsset(vaultAddress))) return true

  return false
}

export const isAnyVaultBlockedByCountry = (...addresses: string[]): boolean => {
  return addresses.some(addr => isVaultBlockedByCountry(addr))
}

export const isVaultRestrictedByCountry = (vaultAddress: string): boolean => {
  if (country.value === undefined) return false // still loading
  if (country.value === null) return true // loaded, country unknown

  const vaultRestricted = getVaultRestricted(vaultAddress)
  if (vaultRestricted?.length && isCountryInList(expandBlockList(vaultRestricted))) return true

  const earnRestricted = getEarnVaultRestricted(vaultAddress)
  if (earnRestricted?.length && isCountryInList(expandBlockList(earnRestricted))) return true

  // Asset-level restriction: a vault is restricted whenever its underlying asset is restricted.
  if (isAssetRestrictedByCountry(getVaultUnderlyingAsset(vaultAddress))) return true

  return false
}

export const isAnyVaultRestrictedByCountry = (...addresses: string[]): boolean => {
  return addresses.some(addr => isVaultRestrictedByCountry(addr))
}

export type VaultTagContext = 'browse' | 'swap-target' | 'supply-source'

export const getVaultTags = (
  vaultAddress: string,
  context: VaultTagContext = 'browse',
): { tags: string[], disabled: boolean } => {
  const tags: string[] = []
  const blocked = isVaultBlockedByCountry(vaultAddress)
  const restricted = !blocked && isVaultRestrictedByCountry(vaultAddress)

  if (blocked) tags.push('Restricted')
  // Soft-restricted: only show tag when the context involves acquiring more exposure
  if (restricted && context === 'swap-target') tags.push('Restricted')
  if (isVaultDeprecated(vaultAddress)) tags.push('Deprecated')

  const disabled = blocked
    || isVaultDeprecated(vaultAddress)
    || (restricted && context === 'swap-target')

  return { tags, disabled }
}
