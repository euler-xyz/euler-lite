import type { EulerEarn, SecuritizeCollateralVault, EVault, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { fetchVaultCategory } from '~/utils/vault/categories'
import { getAddress, type Address } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import { normalizeAddress } from '~/utils/normalizeAddress'
import { isVaultNotExplorable } from '~/utils/eulerLabelsUtils'
import { liteSecuritizeVaultFetchOptions, liteVaultFetchOptions } from '~/utils/sdk-fetch-options'

// Vault type enum - 3 types (escrow is a category of evk, not a separate type)
export type VaultType = 'evk' | 'earn' | 'securitize'

interface RegistryToken {
  address: Address
  name: string
  symbol: string
  decimals: number
  logoURI?: string
}

export interface AnyVault {
  type: string
  chainId: number
  address: Address
  shares: RegistryToken
  asset: RegistryToken
  totalShares: bigint
  totalAssets: bigint
}

// Registry entry containing vault and its type
export interface VaultEntry {
  vault: AnyVault
  type: VaultType
  verified: boolean
  vaultCategory?: 'standard' | 'escrow'
}

interface VaultEntryMetadata {
  verified?: boolean
  vaultCategory?: 'standard' | 'escrow'
}

// Registry state
const registry: Ref<Map<string, VaultEntry>> = shallowRef(new Map())
const isLoading = ref(false)
const registryVersion = ref(0)

// In-flight resolution promises — deduplicates concurrent getOrFetch() calls for the same vault
const pendingResolutions = new Map<string, Promise<VaultEntity | undefined>>()

// Escrow address set - populated early, before full vault info is loaded
// Used for O(1) lookups to determine if an address is an escrow vault
const escrowAddresses: Ref<Set<string>> = shallowRef(new Set())

// Get vault entry from registry
const get = (address: string): VaultEntry | undefined => {
  return registry.value.get(normalizeAddress(address))
}

// Check if vault exists in registry
const has = (address: string): boolean => {
  return registry.value.has(normalizeAddress(address))
}

// Get just the vault (for backward compatibility)
const getVault = (address: string): VaultEntity | undefined => {
  return get(address)?.vault as VaultEntity | undefined
}

// Get just the type
const getType = (address: string): VaultType | undefined => {
  return get(address)?.type
}

// Register a vault
const inferEntryMetadata = (_vault: AnyVault, _type: VaultType, metadata?: VaultEntryMetadata): VaultEntryMetadata => ({
  verified: metadata?.verified,
  vaultCategory: metadata?.vaultCategory,
})

const set = (address: string, vault: AnyVault, type: VaultType, metadata?: VaultEntryMetadata): void => {
  const normalized = normalizeAddress(address)
  // Preserve existing verification/category when the caller doesn't supply it.
  // Refresh paths (updateVault, getBorrowVaultPair fallbacks) re-set a vault
  // with no metadata; without this they'd downgrade an already-verified vault
  // to verified:false, dropping it from getVerifiedEVaults() and the lists.
  const existing = registry.value.get(normalized)
  const entryMetadata = inferEntryMetadata(vault, type, metadata)
  const verified = entryMetadata.verified ?? existing?.verified ?? false
  const vaultCategory = entryMetadata.vaultCategory ?? existing?.vaultCategory
  registry.value.set(normalized, {
    vault,
    type,
    verified,
    ...(vaultCategory ? { vaultCategory } : {}),
  })
  registry.value = new Map(registry.value) // Trigger reactivity
  registryVersion.value++
}

// Register multiple vaults
const setMany = (entries: Array<{ address: string, vault: AnyVault, type: VaultType } & VaultEntryMetadata>): void => {
  entries.forEach(({ address, vault, type, verified, vaultCategory }) => {
    const entryMetadata = inferEntryMetadata(vault, type, { verified, vaultCategory })
    registry.value.set(normalizeAddress(address), {
      vault,
      type,
      verified: entryMetadata.verified ?? false,
      ...(entryMetadata.vaultCategory ? { vaultCategory: entryMetadata.vaultCategory } : {}),
    })
  })
  registry.value = new Map(registry.value) // Trigger reactivity
  registryVersion.value++
}

// Clear registry (for chain switching)
const clear = (): void => {
  registry.value = new Map()
  escrowAddresses.value = new Set()
  pendingResolutions.clear()
  registryVersion.value++
}

// Set escrow addresses (populated early, before vault info is loaded)
const setEscrowAddresses = (addresses: string[]): void => {
  const normalizedSet = new Set(addresses.map(addr => normalizeAddress(addr)))
  escrowAddresses.value = normalizedSet
}

// Check if an address is a known escrow address (O(1) lookup)
const isKnownEscrowAddress = (address: string): boolean => {
  return escrowAddresses.value.has(normalizeAddress(address))
}

// Get all vaults of a specific type
const getByType = (type: VaultType): AnyVault[] => {
  return [...registry.value.values()]
    .filter(entry => entry.type === type)
    .map(entry => entry.vault)
}

// Get all entries
const getAll = (): VaultEntry[] => {
  return [...registry.value.values()]
}

// Get vaults matching multiple types (e.g., ['evk', 'escrow'] for combined lookups)
const getByTypes = (types: VaultType[]): AnyVault[] => {
  return [...registry.value.values()]
    .filter(entry => types.includes(entry.type))
    .map(entry => entry.vault)
}

// Typed getters for each vault type
const getEVaults = (): EVault[] => getByType('evk') as EVault[]
const getEarnVaults = (): EulerEarn[] => getByType('earn') as EulerEarn[]
const getSecuritizeVaults = (): SecuritizeCollateralVault[] => getByType('securitize') as SecuritizeCollateralVault[]

// Escrow vaults are EVaults with vaultCategory: 'escrow'
const getEscrowVaults = (): EVault[] => {
  return [...registry.value.values()]
    .filter(entry => entry.type === 'evk' && entry.vaultCategory === 'escrow')
    .map(entry => entry.vault) as EVault[]
}

// Standard EVaults (non-escrow)
const getStandardEVaults = (): EVault[] => {
  return [...registry.value.values()]
    .filter(entry => entry.type === 'evk' && entry.vaultCategory !== 'escrow')
    .map(entry => entry.vault) as EVault[]
}

// Verified EVaults (for display in tables) - excludes dynamically fetched unknown vaults
const getVerifiedEVaults = (includeNotExplorable = false): EVault[] => {
  return [...registry.value.values()]
    .filter(entry =>
      entry.type === 'evk'
      && entry.verified === true
      && (includeNotExplorable || !isVaultNotExplorable(entry.vault.address)),
    )
    .map(entry => entry.vault) as EVault[]
}

// Type checker convenience methods
const isEscrowVault = (address: string): boolean => {
  const entry = get(address)
  if (entry) {
    if (entry.type !== 'evk') return false
    return entry.vaultCategory === 'escrow'
  }
  // Fallback: check escrow addresses set (vault info not loaded yet)
  return isKnownEscrowAddress(address)
}

const isEarnVault = (address: string): boolean => getType(address) === 'earn'
const isSecuritizeVault = (address: string): boolean => getType(address) === 'securitize'
const isEVaultAddress = (address: string): boolean => getType(address) === 'evk'
const isVerifiedVault = (address: string): boolean => {
  const { verifiedVaultAddresses, earnVaults } = useEulerLabels()
  const normalized = normalizeAddress(address)
  return get(normalized)?.verified === true
    || escrowAddresses.value.has(normalized)
    || verifiedVaultAddresses.value.some(vault => normalizeAddress(vault) === normalized)
    || earnVaults.value.some(vault => normalizeAddress(vault) === normalized)
}
const getVaultCategory = (address: string): 'standard' | 'escrow' | undefined => {
  return get(address)?.vaultCategory ?? (isKnownEscrowAddress(address) ? 'escrow' : undefined)
}

// Reactive size for watchers
const size = computed(() => registry.value.size)

/**
 * Fetch vault using the appropriate SDK service based on type.
 * Escrow vaults are an EVault category, so they use the EVault service.
 */
const fetchVaultByType = async (address: string, type: VaultType): Promise<VaultEntity> => {
  const { chainId } = useEulerAddresses()
  const { getEulerSdkForChain } = useEulerSdk()
  const sdk = await getEulerSdkForChain(chainId.value)
  const vaultAddress = getAddress(address) as Address
  switch (type) {
    case 'earn': {
      const { result } = await sdk.eulerEarnService.fetchVault(chainId.value, vaultAddress, liteVaultFetchOptions)
      if (!result) throw new Error(`Earn vault not found for ${address}`)
      return result
    }
    case 'securitize': {
      const { result } = await sdk.securitizeVaultService.fetchVault(chainId.value, vaultAddress, liteSecuritizeVaultFetchOptions)
      if (!result) throw new Error(`Securitize vault not found for ${address}`)
      return result
    }
    case 'evk':
    default: {
      const { result } = await sdk.eVaultService.fetchVault(chainId.value, vaultAddress, liteVaultFetchOptions)
      if (!result) throw new Error(`EVault not found for ${address}`)
      return result
    }
  }
}

/**
 * Resolve an unknown vault using SDK vault metadata, fetch with the appropriate
 * SDK service, and cache in the registry. Escrow category comes from the SDK
 * verified-array read, so no separate local perspective probe is needed.
 */
const resolveUnknown = async (address: string): Promise<VaultEntry> => {
  const normalized = normalizeAddress(address)
  const category = await fetchVaultCategory(normalized)

  let type: VaultType
  if (category === 'earn') {
    type = 'earn'
  }
  else if (category === 'securitize') {
    type = 'securitize'
  }
  else if (category === 'escrow' || category === 'evk') {
    type = 'evk'
  }
  else {
    // SDK metadata returned null/unknown. This can happen for brand-new
    // deployments. Try securitize first (has distinct structure), fall back to
    // EVault.
    logWarn('resolveUnknown', `Category not found for ${address}, trying fetch methods`)
    try {
      const vault = await fetchVaultByType(normalized, 'securitize')
      set(normalized, vault, 'securitize')
      return get(normalized)!
    }
    catch {
      type = 'evk'
    }
  }

  if (type === 'evk' && category === 'escrow') {
    const vault = await fetchVaultByType(normalized, 'evk')
    set(normalized, vault, 'evk', { verified: true, vaultCategory: 'escrow' })
    return get(normalized)!
  }

  const vault = await fetchVaultByType(normalized, type)
  set(normalized, vault, type)
  return get(normalized)!
}

/**
 * Get vault from registry, or fetch and cache if not found.
 * Primary method for vault resolution. After calling, use getType(address) if you need the type.
 */
const getOrFetch = async (address: string): Promise<VaultEntity | undefined> => {
  // Check registry first
  const existing = get(address)
  if (existing) {
    return existing.vault as VaultEntity
  }

  const normalized = normalizeAddress(address)

  // Return existing in-flight promise if one exists (deduplicates concurrent calls)
  const pending = pendingResolutions.get(normalized)
  if (pending) {
    return pending
  }

  // Create and track new resolution promise
  const resolution = resolveUnknown(address)
    .then(entry => entry.vault as VaultEntity)
    .catch((e) => {
      logWarn('vaultRegistry/resolve', e)
      return undefined
    })
    .finally(() => {
      pendingResolutions.delete(normalized)
    })

  pendingResolutions.set(normalized, resolution)
  return resolution
}

export const useVaultRegistry = () => {
  return {
    // State
    registry,
    isLoading,
    size,
    registryVersion,
    escrowAddresses,

    // Basic operations
    get,
    has,
    getVault,
    getType,
    set,
    setMany,
    clear,

    // Escrow address set operations (for lazy loading optimization)
    setEscrowAddresses,
    isKnownEscrowAddress,

    // Queries
    getByType,
    getByTypes,
    getAll,

    // Typed getters
    getEVaults,
    getEarnVaults,
    getEscrowVaults,
    getSecuritizeVaults,
    getStandardEVaults,
    getVerifiedEVaults,

    // Type checkers
    isEscrowVault,
    isEarnVault,
    isSecuritizeVault,
    isEVaultAddress,
    isVerifiedVault,
    getVaultCategory,

    // Type detection & fetching
    fetchVaultByType,

    // Resolution (primary method for vault resolution)
    resolveUnknown,
    getOrFetch,
  }
}
