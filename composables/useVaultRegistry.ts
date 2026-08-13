import type { EulerEarn, SecuritizeCollateralVault, EVault, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { fetchVaultCategory } from '~/utils/vault/categories'
import { getAddress, type Address } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import { normalizeAddress } from '~/utils/normalizeAddress'
import { isVaultNotExplorable } from '~/utils/eulerLabelsUtils'
import { liteSecuritizeVaultFetchOptions, liteVaultFetchOptions } from '~/utils/sdk-fetch-options'
import { resolveEulerRouterGovernors } from '~/utils/vault/euler-router-governance'
import { governableGovernorAbi } from '~/abis/oracle'

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
const resolutionGenerations = new Map<number, number>()

const getActiveChainId = (): number | undefined => {
  try {
    return useEulerAddresses().chainId.value
  }
  catch {
    return undefined
  }
}

const registryKey = (chainId: number, address: string): string =>
  `${chainId}:${normalizeAddress(address)}`

const getForChain = (chainId: number, address: string): VaultEntry | undefined =>
  registry.value.get(registryKey(chainId, address))

const activeEntries = (): VaultEntry[] => {
  const chainId = getActiveChainId()
  if (!chainId) return []
  return [...registry.value.entries()]
    .filter(([key]) => key.startsWith(`${chainId}:`))
    .map(([, entry]) => entry)
}

const getResolutionGeneration = (chainId: number): number =>
  resolutionGenerations.get(chainId) ?? 0

const isCurrentResolution = (chainId: number, generation: number): boolean =>
  getActiveChainId() === chainId && getResolutionGeneration(chainId) === generation

// In-flight resolution promises — deduplicates concurrent getOrFetch() calls for the same vault
const pendingResolutions = new Map<string, Promise<VaultEntity | undefined>>()

// Escrow address set - populated early, before full vault info is loaded
// Used for O(1) lookups to determine if an address is an escrow vault
const escrowAddressesByChain = new Map<number, Set<string>>()
const escrowVersion = ref(0)
const escrowAddresses = computed(() => {
  void escrowVersion.value
  const chainId = getActiveChainId()
  return chainId ? (escrowAddressesByChain.get(chainId) ?? new Set<string>()) : new Set<string>()
})

// Get vault entry from registry
const get = (address: string): VaultEntry | undefined => {
  const chainId = getActiveChainId()
  return chainId ? getForChain(chainId, address) : undefined
}

// Check if vault exists in registry
const has = (address: string): boolean => {
  return get(address) !== undefined
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
  const key = registryKey(vault.chainId, address)
  // Preserve existing verification/category when the caller doesn't supply it.
  // Refresh paths (updateVault, getBorrowVaultPair fallbacks) re-set a vault
  // with no metadata; without this they'd downgrade an already-verified vault
  // to verified:false, dropping it from getVerifiedEVaults() and the lists.
  const existing = registry.value.get(key)
  const entryMetadata = inferEntryMetadata(vault, type, metadata)
  const verified = entryMetadata.verified ?? existing?.verified ?? false
  const vaultCategory = entryMetadata.vaultCategory ?? existing?.vaultCategory
  registry.value.set(key, {
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
    registry.value.set(registryKey(vault.chainId, address), {
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
  const chainId = getActiveChainId()
  if (!chainId) {
    registry.value = new Map()
    escrowAddressesByChain.clear()
    escrowVersion.value++
    pendingResolutions.clear()
    resolutionGenerations.clear()
    registryVersion.value++
    return
  }

  registry.value = new Map(
    [...registry.value.entries()].filter(([key]) => !key.startsWith(`${chainId}:`)),
  )
  escrowAddressesByChain.delete(chainId)
  escrowVersion.value++
  resolutionGenerations.set(chainId, getResolutionGeneration(chainId) + 1)
  for (const key of pendingResolutions.keys()) {
    if (key.startsWith(`${chainId}:`)) pendingResolutions.delete(key)
  }
  registryVersion.value++
}

// Set escrow addresses (populated early, before vault info is loaded)
const setEscrowAddresses = (addresses: string[], targetChainId = getActiveChainId()): void => {
  if (!targetChainId) return
  const normalizedSet = new Set(addresses.map(addr => normalizeAddress(addr)))
  escrowAddressesByChain.set(targetChainId, normalizedSet)
  escrowVersion.value++
}

// Check if an address is a known escrow address (O(1) lookup)
const isKnownEscrowAddress = (address: string): boolean => {
  return escrowAddresses.value.has(normalizeAddress(address))
}

// Get all vaults of a specific type
const getByType = (type: VaultType): AnyVault[] => {
  return activeEntries()
    .filter(entry => entry.type === type)
    .map(entry => entry.vault)
}

// Get all entries
const getAll = (): VaultEntry[] => {
  return activeEntries()
}

// Get vaults matching multiple types (e.g., ['evk', 'escrow'] for combined lookups)
const getByTypes = (types: VaultType[]): AnyVault[] => {
  return activeEntries()
    .filter(entry => types.includes(entry.type))
    .map(entry => entry.vault)
}

// Typed getters for each vault type
const getEVaults = (): EVault[] => getByType('evk') as EVault[]
const getEarnVaults = (): EulerEarn[] => getByType('earn') as EulerEarn[]
const getSecuritizeVaults = (): SecuritizeCollateralVault[] => getByType('securitize') as SecuritizeCollateralVault[]

// Escrow vaults are EVaults with vaultCategory: 'escrow'
const getEscrowVaults = (): EVault[] => {
  return activeEntries()
    .filter(entry => entry.type === 'evk' && entry.vaultCategory === 'escrow')
    .map(entry => entry.vault) as EVault[]
}

// Standard EVaults (non-escrow)
const getStandardEVaults = (): EVault[] => {
  return activeEntries()
    .filter(entry => entry.type === 'evk' && entry.vaultCategory !== 'escrow')
    .map(entry => entry.vault) as EVault[]
}

// Verified EVaults (for display in tables) - excludes dynamically fetched unknown vaults
const getVerifiedEVaults = (includeNotExplorable = false): EVault[] => {
  return activeEntries()
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
    || isKnownEscrowAddress(normalized)
    || verifiedVaultAddresses.value.some(vault => normalizeAddress(vault) === normalized)
    || earnVaults.value.some(vault => normalizeAddress(vault) === normalized)
}
const getVaultCategory = (address: string): 'standard' | 'escrow' | undefined => {
  return get(address)?.vaultCategory ?? (isKnownEscrowAddress(address) ? 'escrow' : undefined)
}

// Reactive size for watchers
const size = computed(() => {
  void registryVersion.value
  return activeEntries().length
})

/**
 * Fetch vault using the appropriate SDK service based on type.
 * Escrow vaults are an EVault category, so they use the EVault service.
 */
const fetchVaultByType = async (
  address: string,
  type: VaultType,
  targetChainId = getActiveChainId(),
): Promise<VaultEntity> => {
  if (!targetChainId) throw new Error('Cannot fetch a vault without an active chain')
  const { getEulerSdkForChain } = useEulerSdk()
  const sdk = await getEulerSdkForChain(targetChainId)
  const vaultAddress = getAddress(address) as Address
  switch (type) {
    case 'earn': {
      const { result } = await sdk.eulerEarnService.fetchVault(targetChainId, vaultAddress, liteVaultFetchOptions)
      if (!result) throw new Error(`Earn vault not found for ${address}`)
      return result
    }
    case 'securitize': {
      const { result } = await sdk.securitizeVaultService.fetchVault(targetChainId, vaultAddress, liteSecuritizeVaultFetchOptions)
      if (!result) throw new Error(`Securitize vault not found for ${address}`)
      return result
    }
    case 'evk':
    default: {
      const { result } = await sdk.eVaultService.fetchVault(targetChainId, vaultAddress, liteVaultFetchOptions)
      if (!result) throw new Error(`EVault not found for ${address}`)
      await resolveEulerRouterGovernors([result], (router) => {
        const provider = sdk.providerService.getProvider(targetChainId)
        return provider.readContract({
          address: router,
          abi: governableGovernorAbi,
          functionName: 'governor',
          authorizationList: undefined,
        })
      })
      return result
    }
  }
}

/**
 * Resolve an unknown vault using SDK vault metadata, fetch with the appropriate
 * SDK service, and cache in the registry. Escrow category comes from the SDK
 * verified-array read, so no separate local perspective probe is needed.
 */
const resolveUnknown = async (
  address: string,
  targetChainId = getActiveChainId(),
  generation = targetChainId ? getResolutionGeneration(targetChainId) : 0,
): Promise<VaultEntry | undefined> => {
  if (!targetChainId) return undefined
  const normalized = normalizeAddress(address)
  const category = await fetchVaultCategory(normalized, targetChainId)
  if (!isCurrentResolution(targetChainId, generation)) return undefined

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
      const vault = await fetchVaultByType(normalized, 'securitize', targetChainId)
      if (!isCurrentResolution(targetChainId, generation)) return undefined
      set(normalized, vault, 'securitize')
      return getForChain(targetChainId, normalized)
    }
    catch {
      type = 'evk'
    }
  }

  if (type === 'evk' && category === 'escrow') {
    const vault = await fetchVaultByType(normalized, 'evk', targetChainId)
    if (!isCurrentResolution(targetChainId, generation)) return undefined
    set(normalized, vault, 'evk', { verified: true, vaultCategory: 'escrow' })
    return getForChain(targetChainId, normalized)
  }

  const vault = await fetchVaultByType(normalized, type, targetChainId)
  if (!isCurrentResolution(targetChainId, generation)) return undefined
  set(normalized, vault, type)
  return getForChain(targetChainId, normalized)
}

/**
 * Get vault from registry, or fetch and cache if not found.
 * Primary method for vault resolution. After calling, use getType(address) if you need the type.
 */
const getOrFetch = async (address: string): Promise<VaultEntity | undefined> => {
  const targetChainId = getActiveChainId()
  if (!targetChainId) return undefined
  // Check registry first
  const existing = getForChain(targetChainId, address)
  if (existing) {
    return existing.vault as VaultEntity
  }

  const normalized = normalizeAddress(address)
  const key = registryKey(targetChainId, normalized)
  const generation = getResolutionGeneration(targetChainId)

  // Return existing in-flight promise if one exists (deduplicates concurrent calls)
  const pending = pendingResolutions.get(key)
  if (pending) {
    return pending
  }

  // Create and track new resolution promise
  const resolution = resolveUnknown(address, targetChainId, generation)
    .then(entry => entry?.vault as VaultEntity | undefined)
    .catch((e) => {
      logWarn('vaultRegistry/resolve', e)
      return undefined
    })
    .finally(() => {
      if (pendingResolutions.get(key) === resolution) {
        pendingResolutions.delete(key)
      }
    })

  pendingResolutions.set(key, resolution)
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
