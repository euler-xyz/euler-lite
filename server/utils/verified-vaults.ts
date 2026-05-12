import type { Address } from 'viem'
import { createTtlCache } from './cache'
import { fetchEscrowPerspectiveAddresses } from './escrow-perspective'
import {
  buildDeprecatedEarnSet,
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
  const [products, entities, earn, escrow, snapshot] = await Promise.allSettled([
    fetchLabels<Record<string, ProductEntry>>(chainId, 'products.json'),
    fetchLabels<Record<string, EntityEntry>>(chainId, 'entities.json'),
    fetchLabels<unknown[]>(chainId, 'earn-vaults.json'),
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

  const { declaredKeysByVault, deprecatedSet } = buildProductMaps(products.value ?? {})
  const entityAddresses = buildEntityAddressSets(entities.value ?? {})

  const deprecatedEarnSet = earn.status === 'fulfilled' && Array.isArray(earn.value)
    ? buildDeprecatedEarnSet(earn.value)
    : new Set<Address>()
  if (earn.status === 'rejected') {
    logger.warn({ ctx: 'verified-vaults', chainId, err: earn.reason }, 'earn-vaults fetch failed')
  }

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

  // Last step (server-only): deprecated vaults are treated as unknown,
  // overriding any verification that might otherwise have passed (e.g.
  // when on-chain governor still matches the entity).
  for (const addr of deprecatedSet) result.delete(addr)
  for (const addr of deprecatedEarnSet) result.delete(addr)

  return result
}

export async function getVerifiedAddressSet(chainId: number): Promise<Set<string>> {
  const key = String(chainId)
  const fresh = cache.get(key)
  if (fresh) return fresh

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
