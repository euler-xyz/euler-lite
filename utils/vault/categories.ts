/**
 * Client-side helpers for vault categorization.
 *
 * Reads vault type classification from the SDK vault meta service and escrow
 * membership from the SDK EVault service. The client caches the full per-chain
 * categorization and individual-address lookups in memory for the session.
 */
import { StandardEVaultPerspectives, VaultType } from '@eulerxyz/euler-v2-sdk'
import { getAddress, isAddress, type Address } from 'viem'
import { logger } from '~/utils/logger'

export type VaultCategory = 'evk' | 'earn' | 'securitize' | 'escrow'

/**
 * Invariant: every address in `escrow` also appears in `evk`. Consumers that
 * want "all EVault-compatible vaults" iterate `evk`; consumers that want to
 * distinguish escrow check `escrow` (or the per-address lookup).
 */
export interface VaultCategories {
  evk: string[]
  earn: string[]
  securitize: string[]
  escrow: string[]
}

const chainCategoriesCache = new Map<number, VaultCategories>()
const chainCategoriesInFlight = new Map<number, Promise<VaultCategories | null>>()
const perAddressCache = new Map<string, VaultCategory>()
const perAddressInFlight = new Map<string, Promise<VaultCategory | null>>()
const escrowAddressCache = new Map<number, Set<string>>()
const escrowAddressInFlight = new Map<number, Promise<Set<string>>>()

const emptyCategories = (): VaultCategories => ({ evk: [], earn: [], securitize: [], escrow: [] })

const getChainId = (): number | null => {
  try {
    const { chainId } = useEulerAddresses()
    return chainId.value ?? null
  }
  catch {
    return null
  }
}

const cacheKey = (chainId: number, address: string) => `${chainId}:${address.toLowerCase()}`

const normalize = (address: string): Address => getAddress(address) as Address

const uniqueAddresses = (addresses: Iterable<string>): Address[] => {
  const set = new Map<string, Address>()
  for (const address of addresses) {
    if (!isAddress(address)) continue
    const normalized = normalize(address)
    set.set(normalized.toLowerCase(), normalized)
  }
  return [...set.values()]
}

const mapVaultType = (type: unknown): Exclude<VaultCategory, 'escrow'> | null => {
  switch (type) {
    case VaultType.EVault:
      return 'evk'
    case VaultType.EulerEarn:
      return 'earn'
    case VaultType.SecuritizeCollateral:
      return 'securitize'
    default:
      return null
  }
}

const getSdk = async (chainId: number) => {
  const { getEulerSdkForChain } = useEulerSdk()
  return await getEulerSdkForChain(chainId)
}

const fetchEscrowAddressSet = async (chainId: number): Promise<Set<string>> => {
  const cached = escrowAddressCache.get(chainId)
  if (cached) return cached

  const existing = escrowAddressInFlight.get(chainId)
  if (existing) return existing

  const promise = getSdk(chainId)
    .then(sdk => sdk.eVaultService.fetchVerifiedVaultAddresses(chainId, [StandardEVaultPerspectives.ESCROW]))
    .then(addresses => new Set(uniqueAddresses(addresses).map(address => address.toLowerCase())))
    .then((set) => {
      escrowAddressCache.set(chainId, set)
      return set
    })
    .catch((err) => {
      logger.warn({ ctx: 'fetchEscrowAddressSet', chainId, err }, 'failed to fetch escrow vault addresses')
      return new Set<string>()
    })
    .finally(() => { escrowAddressInFlight.delete(chainId) })

  escrowAddressInFlight.set(chainId, promise)
  return promise
}

const addCategory = (categories: VaultCategories, category: VaultCategory, address: string) => {
  const normalized = normalize(address)
  const list = categories[category]
  if (!list.some(existing => existing.toLowerCase() === normalized.toLowerCase())) {
    list.push(normalized)
  }
}

const populatePerAddressFromCategories = (chainId: number, categories: VaultCategories) => {
  // Index the full categorization into the per-address cache so subsequent
  // single-address lookups don't need to roundtrip.
  for (const addr of categories.escrow) perAddressCache.set(cacheKey(chainId, addr), 'escrow')
  for (const addr of categories.evk) {
    const key = cacheKey(chainId, addr)
    // Don't overwrite 'escrow' with 'evk' — escrow is the more specific label.
    if (!perAddressCache.has(key)) perAddressCache.set(key, 'evk')
  }
  for (const addr of categories.earn) perAddressCache.set(cacheKey(chainId, addr), 'earn')
  for (const addr of categories.securitize) perAddressCache.set(cacheKey(chainId, addr), 'securitize')
}

/**
 * Fetch (or reuse cached) the full chain categorization. Deduplicates
 * concurrent callers for the same chain onto one SDK request set.
 */
export const fetchChainVaultCategories = async (): Promise<VaultCategories> => {
  const chainId = getChainId()
  if (!chainId) return emptyCategories()

  const cached = chainCategoriesCache.get(chainId)
  if (cached) return cached

  const existing = chainCategoriesInFlight.get(chainId)
  if (existing) return (await existing) ?? emptyCategories()

  const promise = (async () => {
    const { verifiedVaultAddresses, earnVaults } = useEulerLabels()
    const categories = emptyCategories()
    const escrowAddresses = await fetchEscrowAddressSet(chainId)
    const labelledEarn = new Set(uniqueAddresses(earnVaults.value).map(address => address.toLowerCase()))
    const labelledVerified = uniqueAddresses(verifiedVaultAddresses.value)
    const addresses = uniqueAddresses([
      ...labelledVerified,
      ...earnVaults.value,
      ...[...escrowAddresses],
    ])

    for (const address of escrowAddresses) {
      addCategory(categories, 'escrow', address)
      addCategory(categories, 'evk', address)
    }

    let types: Partial<Record<Address, unknown>> = {}
    if (addresses.length > 0) {
      try {
        types = await (await getSdk(chainId)).vaultMetaService.fetchVaultTypes(chainId, addresses)
      }
      catch (err) {
        logger.warn({ ctx: 'fetchChainVaultCategories/types', chainId, err }, 'failed to fetch sdk vault types')
      }
    }

    for (const address of addresses) {
      const resolvedType = types[address] ?? types[normalize(address)]
      const category = mapVaultType(resolvedType)
      if (category) addCategory(categories, category, address)
    }

    for (const address of earnVaults.value) {
      if (isAddress(address)) addCategory(categories, 'earn', address)
    }

    for (const address of labelledVerified) {
      const lower = address.toLowerCase()
      if (
        !labelledEarn.has(lower)
        && !categories.securitize.some(v => v.toLowerCase() === lower)
      ) {
        addCategory(categories, 'evk', address)
      }
    }

    chainCategoriesCache.set(chainId, categories)
    populatePerAddressFromCategories(chainId, categories)
    return categories
  })()
    .catch((err) => {
      logger.warn({ ctx: 'fetchChainVaultCategories', chainId, err }, 'failed to fetch chain vault categories')
      return null
    })
    .finally(() => { chainCategoriesInFlight.delete(chainId) })

  chainCategoriesInFlight.set(chainId, promise)
  return (await promise) ?? emptyCategories()
}

/**
 * Resolve the category of a single vault address from SDK metadata. Escrow
 * membership is checked first because escrow is a more specific EVault label.
 */
export const fetchVaultCategory = async (
  address: string,
  targetChainId?: number,
): Promise<VaultCategory | null> => {
  const chainId = targetChainId ?? getChainId()
  if (!chainId || !isAddress(address)) return null

  const normalized = normalize(address)
  const key = cacheKey(chainId, normalized)
  const cached = perAddressCache.get(key)
  if (cached) return cached

  const existing = perAddressInFlight.get(key)
  if (existing) return existing

  const promise = (async () => {
    const escrowAddresses = await fetchEscrowAddressSet(chainId)
    if (escrowAddresses.has(normalized.toLowerCase())) {
      perAddressCache.set(key, 'escrow')
      return 'escrow' satisfies VaultCategory
    }

    const type = await (await getSdk(chainId)).vaultMetaService.fetchVaultType(chainId, normalized)
    const category = mapVaultType(type)
    if (category) {
      perAddressCache.set(key, category)
    }
    return category
  })()
    .catch((err) => {
      logger.warn({ ctx: 'fetchVaultCategory', chainId, address: normalized, err }, 'failed to fetch vault category')
      return null
    })
    .finally(() => { perAddressInFlight.delete(key) })

  perAddressInFlight.set(key, promise)
  return promise
}

/**
 * Check if an address is a securitize vault. Registry type wins; otherwise
 * falls back to SDK-backed categorization.
 */
export const isSecuritizeVault = async (address: string): Promise<boolean> => {
  try {
    const { useVaultRegistry } = await import('~/composables/useVaultRegistry')
    const { getType } = useVaultRegistry()
    const registryType = getType(address)
    if (registryType) return registryType === 'securitize'
  }
  catch {
    // registry unavailable (e.g. called outside setup) — fall through
  }

  const category = await fetchVaultCategory(address)
  return category === 'securitize'
}

/** Clear in-memory per-session caches on chain switch or other invalidation. */
export const resetVaultCategoryCache = (): void => {
  chainCategoriesCache.clear()
  chainCategoriesInFlight.clear()
  perAddressCache.clear()
  perAddressInFlight.clear()
  escrowAddressCache.clear()
  escrowAddressInFlight.clear()
}
