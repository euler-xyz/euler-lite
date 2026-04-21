/**
 * Client-side helpers for vault categorization.
 *
 * Reads the chain-wide categorization from /api/vault-categories (cached
 * server-side with a 5-min TTL + warm-cache). The client caches the full
 * per-chain categorization and individual-address lookups in memory for
 * the session — the upstream TTL is authoritative, in-session cache just
 * avoids re-fetching on re-entry to the same page.
 *
 * Replaces the old factory-based API (fetchVaultFactory / fetchVaultFactories)
 * which hit /api/vault-factories with a per-address subgraph lookup.
 */
import { logWarn } from '~/utils/errorHandling'

export type VaultCategory = 'evk' | 'earn' | 'securitize' | 'escrow'

/**
 * Shape returned by GET /api/vault-categories?chainId=X.
 *
 * Invariant: every address in `escrow` also appears in `evk`. Consumers that
 * want "all EVK-compatible vaults" iterate `evk`; consumers that want to
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
 * concurrent callers for the same chain onto one HTTP round-trip.
 */
export const fetchChainVaultCategories = async (): Promise<VaultCategories> => {
  const chainId = getChainId()
  if (!chainId) return emptyCategories()

  const cached = chainCategoriesCache.get(chainId)
  if (cached) return cached

  const existing = chainCategoriesInFlight.get(chainId)
  if (existing) return (await existing) ?? emptyCategories()

  const promise = $fetch<VaultCategories>('/api/vault-categories', { query: { chainId } })
    .then((data) => {
      const categories = {
        evk: data?.evk ?? [],
        earn: data?.earn ?? [],
        securitize: data?.securitize ?? [],
        escrow: data?.escrow ?? [],
      }
      chainCategoriesCache.set(chainId, categories)
      populatePerAddressFromCategories(chainId, categories)
      return categories
    })
    .catch((err) => {
      logWarn('fetchChainVaultCategories', err)
      return null
    })
    .finally(() => { chainCategoriesInFlight.delete(chainId) })

  chainCategoriesInFlight.set(chainId, promise)
  return (await promise) ?? emptyCategories()
}

/**
 * Resolve the category of a single vault address. Falls back to a server-side
 * single-address subgraph query if the full chain categorization hasn't been
 * loaded yet (or if the address is too new to be in it).
 *
 * Note: the single-address fallback does NOT distinguish escrow from evk —
 * escrow membership requires an on-chain perspective check that only runs
 * during the full categorization refresh. If escrow detection matters, load
 * the full categorization first (via fetchChainVaultCategories) or fall back
 * to an explicit escrow check downstream.
 */
export const fetchVaultCategory = async (address: string): Promise<VaultCategory | null> => {
  const chainId = getChainId()
  if (!chainId) return null

  const key = cacheKey(chainId, address)
  const cached = perAddressCache.get(key)
  if (cached) return cached

  // Full categorization doesn't include this address — could be a brand-new
  // deployment the subgraph indexed after our last catalog refresh. Fall
  // through to the server's single-address endpoint which runs a live query.
  const existing = perAddressInFlight.get(key)
  if (existing) return existing

  const promise = $fetch<{ category: VaultCategory | null }>('/api/vault-categories', {
    query: { chainId, address },
  })
    .then((data) => {
      const category = data?.category ?? null
      if (category) perAddressCache.set(key, category)
      return category
    })
    .catch((err) => {
      logWarn('fetchVaultCategory', err)
      return null
    })
    .finally(() => { perAddressInFlight.delete(key) })

  perAddressInFlight.set(key, promise)
  return promise
}

/**
 * Check if an address is a securitize vault. Registry type wins; otherwise
 * falls back to the categorization endpoint.
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
}
