import type { Address } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import { normalizeAddress } from '~/utils/normalizeAddress'
import { isVaultNotExplorable } from '~/utils/eulerLabelsUtils'
import {
  type Vault,
  type EarnVault,
  type SecuritizeVault,
  fetchVault,
  fetchEarnVault,
  fetchEscrowVault,
  fetchSecuritizeVault,
} from '~/entities/vault'
import { fetchVaultCategory } from '~/entities/vault/factory'

// Vault type enum - 3 types (escrow is a category of evk, not a separate type)
export type VaultType = 'evk' | 'earn' | 'securitize'

// Union of all vault types
export type AnyVault = Vault | EarnVault | SecuritizeVault

// Registry entry containing vault and its type
export interface VaultEntry {
  vault: AnyVault
  type: VaultType
}

// Registry state
const registry: Ref<Map<string, VaultEntry>> = shallowRef(new Map())
const isLoading = ref(false)

// In-flight resolution promises — deduplicates concurrent getOrFetch() calls for the same vault
const pendingResolutions = new Map<string, Promise<AnyVault | undefined>>()

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
const getVault = (address: string): AnyVault | undefined => {
  return get(address)?.vault
}

// Get just the type
const getType = (address: string): VaultType | undefined => {
  return get(address)?.type
}

// Register a vault
const set = (address: string, vault: AnyVault, type: VaultType): void => {
  const normalized = normalizeAddress(address)
  registry.value.set(normalized, { vault, type })
  registry.value = new Map(registry.value) // Trigger reactivity
}

// Register multiple vaults
const setMany = (entries: Array<{ address: string, vault: AnyVault, type: VaultType }>): void => {
  entries.forEach(({ address, vault, type }) => {
    registry.value.set(normalizeAddress(address), { vault, type })
  })
  registry.value = new Map(registry.value) // Trigger reactivity
}

// Clear registry (for chain switching)
const clear = (): void => {
  registry.value = new Map()
  escrowAddresses.value = new Set()
  pendingResolutions.clear()
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
const getEvkVaults = (): Vault[] => getByType('evk') as Vault[]
const getEarnVaults = (): EarnVault[] => getByType('earn') as EarnVault[]
const getSecuritizeVaults = (): SecuritizeVault[] => getByType('securitize') as SecuritizeVault[]

// Escrow vaults are EVK vaults with vaultCategory: 'escrow'
const getEscrowVaults = (): Vault[] => {
  return getEvkVaults().filter(v => v.vaultCategory === 'escrow')
}

// Standard EVK vaults (non-escrow)
const getStandardEvkVaults = (): Vault[] => {
  return getEvkVaults().filter(v => v.vaultCategory !== 'escrow')
}

// Verified EVK vaults (for display in tables) - excludes dynamically fetched unknown vaults
const getVerifiedEvkVaults = (includeNotExplorable = false): Vault[] => {
  return getEvkVaults().filter(v =>
    v.verified === true && (includeNotExplorable || !isVaultNotExplorable(v.address)),
  )
}

// Type checker convenience methods
const isEscrowVault = (address: string): boolean => {
  const entry = get(address)
  if (entry) {
    if (entry.type !== 'evk') return false
    const vault = entry.vault as Vault
    return vault.vaultCategory === 'escrow'
  }
  // Fallback: check escrow addresses set (vault info not loaded yet)
  return isKnownEscrowAddress(address)
}

const isEarnVault = (address: string): boolean => getType(address) === 'earn'
const isSecuritizeVault = (address: string): boolean => getType(address) === 'securitize'
const isEvkVault = (address: string): boolean => getType(address) === 'evk'

// Reactive size for watchers
const size = computed(() => registry.value.size)

/**
 * Fetch vault using the appropriate fetch function based on type.
 * Note: Escrow vaults are a category of evk, not a separate type.
 * They are fetched using fetchVault and identified by vaultCategory.
 */
const fetchVaultByType = async (address: string, type: VaultType): Promise<AnyVault> => {
  const ctx = buildFetchContext()
  switch (type) {
    case 'earn':
      return await fetchEarnVault(address, ctx)
    case 'securitize':
      return await fetchSecuritizeVault(address, ctx)
    case 'evk':
    default:
      return await fetchVault(address, ctx)
  }
}

/**
 * Check if a vault is in the escrowedCollateralPerspective.
 */
const isInEscrowPerspective = async (address: string): Promise<boolean> => {
  const { eulerPeripheryAddresses } = useEulerAddresses()
  const { client: rpcClient } = useRpcClient()

  if (!eulerPeripheryAddresses.value?.escrowedCollateralPerspective) {
    return false
  }

  try {
    const client = rpcClient.value!
    return await client.readContract({
      address: eulerPeripheryAddresses.value.escrowedCollateralPerspective as Address,
      abi: [{
        type: 'function',
        name: 'isVerified',
        inputs: [{ name: 'vault', type: 'address' }],
        outputs: [{ name: '', type: 'bool' }],
        stateMutability: 'view',
      }] as const,
      functionName: 'isVerified',
      args: [address as Address],
    })
  }
  catch {
    return false
  }
}

/**
 * Resolve an unknown vault using /api/vault-categories, fetch with the
 * appropriate lens, and cache in the registry. The category endpoint returns
 * 'escrow' directly when the full chain categorization is warm; per-address
 * fallback returns factory-based category only (no escrow check) so we still
 * run a local isInEscrowPerspective probe for the 'evk' case.
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
    // Category endpoint returned null — vault not indexed in the subgraph.
    // This can happen for brand-new deployments. Try securitize first (has
    // distinct structure), fall back to EVK.
    logWarn('resolveUnknown', `Category not found for ${address}, trying fetch methods`)
    try {
      const vault = await fetchSecuritizeVault(normalized, buildFetchContext())
      set(normalized, vault, 'securitize')
      return { vault, type: 'securitize' }
    }
    catch {
      type = 'evk'
    }
  }

  // For EVK vaults the category endpoint may have returned 'escrow' (full
  // categorization hit) — in that case we already know. Otherwise probe the
  // escrow perspective locally to cover brand-new escrow deployments picked
  // up before the full categorization refresh.
  if (type === 'evk') {
    const alreadyEscrow = category === 'escrow'
    const isEscrow = alreadyEscrow || await isInEscrowPerspective(normalized)
    if (isEscrow) {
      const vault = await fetchEscrowVault(normalized, buildFetchContext())
      set(normalized, vault, 'evk')
      return { vault, type: 'evk' }
    }
  }

  const vault = await fetchVaultByType(normalized, type)
  set(normalized, vault, type)
  return { vault, type }
}

/**
 * Get vault from registry, or fetch and cache if not found.
 * Primary method for vault resolution. After calling, use getType(address) if you need the type.
 */
const getOrFetch = async (address: string): Promise<AnyVault | undefined> => {
  // Check registry first
  const existing = get(address)
  if (existing) {
    return existing.vault
  }

  const normalized = normalizeAddress(address)

  // Return existing in-flight promise if one exists (deduplicates concurrent calls)
  const pending = pendingResolutions.get(normalized)
  if (pending) {
    return pending
  }

  // Create and track new resolution promise
  const resolution = resolveUnknown(address)
    .then(entry => entry.vault)
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
    getEvkVaults,
    getEarnVaults,
    getEscrowVaults,
    getSecuritizeVaults,
    getStandardEvkVaults,
    getVerifiedEvkVaults,

    // Type checkers
    isEscrowVault,
    isEarnVault,
    isSecuritizeVault,
    isEvkVault,

    // Type detection & fetching
    fetchVaultByType,

    // Resolution (primary method for vault resolution)
    resolveUnknown,
    getOrFetch,
  }
}
