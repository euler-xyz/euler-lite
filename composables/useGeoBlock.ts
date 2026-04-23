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

// Resolve the underlying asset address for a vault via the registry.
// Used by vault-level helpers to OR-in asset-level rules from assets.json.
const getVaultUnderlyingAsset = (vaultAddress: string): string | undefined => {
  const vault = useVaultRegistry().getVault(vaultAddress)
  return vault?.asset?.address
}

export const isAssetBlockedByCountry = (assetAddress: string | undefined): boolean => {
  if (!assetAddress) return false
  if (country.value === undefined) return false // still loading
  if (country.value === null) return true // loaded, country unknown

  // Sanctioned countries are always blocked
  if (isCountryInList(SANCTIONED_COUNTRIES)) return true

  const assetBlock = getAssetBlock(assetAddress)
  if (assetBlock?.length && isCountryInList(expandBlockList(assetBlock))) return true

  return false
}

export const isAssetRestrictedByCountry = (assetAddress: string | undefined): boolean => {
  if (!assetAddress) return false
  if (country.value === undefined) return false // still loading
  if (country.value === null) return true // loaded, country unknown

  const assetRestricted = getAssetRestricted(assetAddress)
  if (assetRestricted?.length && isCountryInList(expandBlockList(assetRestricted))) return true

  return false
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
