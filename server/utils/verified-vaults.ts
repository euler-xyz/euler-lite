import { createTtlCache } from './cache'
import { fetchEscrowPerspectiveAddresses } from './escrow-perspective'
import {
  buildEntityAddressSets,
  buildProductMaps,
  fetchLabels,
  tryChecksum,
  type EntityEntry,
  type ProductEntry,
} from './labels-helpers'
import { logger } from '~/server/utils/logger'
import { refreshChainVaults, vaultsCache } from './vaults-cache'
import {
  deserialiseSnapshot,
  isEarnVaultOwnerVerified,
  isVaultGovernorVerified,
} from '~/entities/vault'
import type { ChainVaultsSnapshot, VerificationLabels } from '~/entities/vault'

const CACHE_TTL_MS = 300_000

const cache = createTtlCache<Set<string>>({ ttlMs: CACHE_TTL_MS, maxEntries: 64 })
const inflight = new Map<number, Promise<Set<string>>>()

async function loadSnapshot(chainId: number): Promise<ChainVaultsSnapshot> {
  const key = String(chainId)
  const cached = vaultsCache.get(key) ?? vaultsCache.getStale(key)
  const serialised = cached ?? await refreshChainVaults(chainId)
  return deserialiseSnapshot(serialised)
}

async function buildVerifiedSet(chainId: number): Promise<Set<string>> {
  const [products, entities, escrow, snapshot] = await Promise.allSettled([
    fetchLabels<Record<string, ProductEntry>>(chainId, 'products.json'),
    fetchLabels<Record<string, EntityEntry>>(chainId, 'entities.json'),
    fetchEscrowPerspectiveAddresses(chainId),
    loadSnapshot(chainId),
  ])

  if (products.status === 'rejected') {
    const reason = products.reason instanceof Error ? products.reason.message : String(products.reason)
    throw new Error(`products.json fetch failed: ${reason}`)
  }
  if (entities.status === 'rejected') {
    const reason = entities.reason instanceof Error ? entities.reason.message : String(entities.reason)
    throw new Error(`entities.json fetch failed: ${reason}`)
  }
  if (snapshot.status === 'rejected') {
    const reason = snapshot.reason instanceof Error ? snapshot.reason.message : String(snapshot.reason)
    throw new Error(`vault snapshot fetch failed: ${reason}`)
  }

  const { declaredKeysByVault } = buildProductMaps(products.value ?? {})
  const entityAddresses = buildEntityAddressSets(entities.value ?? {})

  const labels: VerificationLabels = {
    getDeclaredEntityKeys: (addr) => {
      const checksum = tryChecksum(addr)
      if (!checksum) return undefined
      return declaredKeysByVault.get(checksum)
    },
    hasEntityAddress: (key, addr) => entityAddresses.get(key)?.has(addr) ?? false,
  }

  const result = new Set<string>()

  // Trust anchor: every address surfaced by the on-chain
  // EscrowedCollateralPerspective is considered known. Matches the client's
  // `vaultCategory === 'escrow'` short-circuit, but applies before the
  // snapshot lookup so escrow vaults missing from the snapshot's collateral
  // subset are still covered.
  if (escrow.status === 'fulfilled') {
    for (const a of escrow.value) {
      const addr = tryChecksum(a)
      if (addr) result.add(addr)
    }
  }
  else {
    logger.warn({ ctx: 'verified-vaults', chainId, err: escrow.reason }, 'escrow fetch failed')
  }

  for (const vault of snapshot.value.evkVaults) {
    if (isVaultGovernorVerified(vault, labels)) {
      const addr = tryChecksum(vault.address)
      if (addr) result.add(addr)
    }
  }
  for (const vault of snapshot.value.securitizeVaults) {
    if (isVaultGovernorVerified(vault, labels)) {
      const addr = tryChecksum(vault.address)
      if (addr) result.add(addr)
    }
  }
  for (const earnVault of snapshot.value.earnVaults) {
    if (isEarnVaultOwnerVerified(earnVault, labels)) {
      const addr = tryChecksum(earnVault.address)
      if (addr) result.add(addr)
    }
  }

  return result
}

/**
 * Force-rebuild path used by the warm-cache plugin. Always rebuilds —
 * bypasses the fresh-cache short-circuit so the warmer can keep the cache
 * continuously fresh on its own schedule rather than waiting for a TTL
 * expiry. Falls back to stale data and re-throws on a hard rebuild failure,
 * matching the read path so a failed warm doesn't poison the cache.
 */
export async function refreshVerifiedAddressSet(chainId: number): Promise<Set<string>> {
  const key = String(chainId)
  const pending = inflight.get(chainId)
  if (pending) return pending

  const task = (async () => {
    try {
      const set = await buildVerifiedSet(chainId)
      cache.set(key, set)
      return set
    }
    catch (err) {
      logger.warn({ ctx: 'verified-vaults', chainId, err }, 'rebuild failed')
      const stale = cache.getStale(key)
      if (stale) return stale
      throw err
    }
    finally {
      inflight.delete(chainId)
    }
  })()

  inflight.set(chainId, task)
  return task
}

export async function getVerifiedAddressSet(chainId: number): Promise<Set<string>> {
  const fresh = cache.get(String(chainId))
  if (fresh) return fresh
  return refreshVerifiedAddressSet(chainId)
}
