import { getAddress, type Address } from 'viem'
import { getInternalFetchHeaders } from './internal-headers'

export interface EntityEntry {
  addresses?: unknown
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

export function buildEntityAddressSets(
  entities: Record<string, EntityEntry>,
): Map<string, Set<Address>> {
  const map = new Map<string, Set<Address>>()
  for (const [key, entity] of Object.entries(entities)) {
    const addresses = new Set<Address>()
    const raw = entity && typeof entity === 'object' ? entity.addresses : undefined
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
  return await $fetch<T>(`/api/internal/labels/${file}`, {
    query: { chainId },
    headers: getInternalFetchHeaders(),
  }) as unknown as T
}
