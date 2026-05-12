import { getAddress, type Address } from 'viem'
import { INTERNAL_FETCH_HEADERS } from './internal-headers'

export interface ProductEntry {
  vaults?: unknown
  deprecatedVaults?: unknown
  entity?: unknown
}

export interface EntityEntry {
  addresses?: unknown
}

export interface EarnVaultEntryObject {
  address?: unknown
  deprecated?: unknown
}

export interface ProductMaps {
  /** address → declared entity keys for the product owning that address. Includes deprecated vaults to mirror the client's `getProductByVault`. */
  declaredKeysByVault: Map<Address, string[]>
  /** Addresses listed under any product's `deprecatedVaults`. */
  deprecatedSet: Set<Address>
}

export function tryChecksum(value: unknown): Address | null {
  if (typeof value !== 'string') return null
  try {
    return getAddress(value)
  }
  catch {
    return null
  }
}

export function declaredKeysOf(rawEntity: unknown): string[] {
  if (Array.isArray(rawEntity)) {
    return rawEntity.filter((v): v is string => typeof v === 'string')
  }
  return typeof rawEntity === 'string' ? [rawEntity] : []
}

export function buildProductMaps(products: Record<string, ProductEntry>): ProductMaps {
  const declaredKeysByVault = new Map<Address, string[]>()
  const deprecatedSet = new Set<Address>()

  for (const product of Object.values(products)) {
    const keys = declaredKeysOf(product.entity)

    if (Array.isArray(product.vaults)) {
      for (const v of product.vaults) {
        const addr = tryChecksum(v)
        if (addr) declaredKeysByVault.set(addr, keys)
      }
    }
    if (Array.isArray(product.deprecatedVaults)) {
      for (const v of product.deprecatedVaults) {
        const addr = tryChecksum(v)
        if (addr) {
          declaredKeysByVault.set(addr, keys)
          deprecatedSet.add(addr)
        }
      }
    }
  }

  return { declaredKeysByVault, deprecatedSet }
}

export function buildDeprecatedEarnSet(entries: unknown[]): Set<Address> {
  const set = new Set<Address>()
  for (const entry of entries) {
    if (entry && typeof entry === 'object') {
      const obj = entry as EarnVaultEntryObject
      if (obj.deprecated !== true) continue
      const addr = tryChecksum(obj.address)
      if (addr) set.add(addr)
    }
  }
  return set
}

export function buildEntityAddressSets(
  entities: Record<string, EntityEntry>,
): Map<string, Set<Address>> {
  const map = new Map<string, Set<Address>>()
  for (const [key, entity] of Object.entries(entities)) {
    const raw = entity.addresses
    const addresses = new Set<Address>()
    if (raw && typeof raw === 'object') {
      for (const addr of Object.keys(raw)) {
        const checksum = tryChecksum(addr)
        if (checksum) addresses.add(checksum)
      }
    }
    map.set(key, addresses)
  }
  return map
}

export async function fetchLabels<T>(
  chainId: number,
  file: 'products.json' | 'entities.json' | 'earn-vaults.json',
): Promise<T> {
  return await $fetch<T>(`/api/labels/${file}`, {
    query: { chainId },
    headers: INTERNAL_FETCH_HEADERS,
  })
}
