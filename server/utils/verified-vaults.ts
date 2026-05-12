import { decodeFunctionResult, encodeFunctionData, getAddress, type Address } from 'viem'
import { createTtlCache } from './cache'
import { fetchWithTimeout } from './fetchWithTimeout'
import { INTERNAL_FETCH_HEADERS } from './internal-headers'
import { logger } from '~/server/utils/logger'
import { resolveRpcUrl } from './rpc'
import { refreshChainVaults, vaultsCache } from './vaults-cache'
import {
  deserialiseSnapshot,
  isEarnVaultOwnerVerified,
  isVaultGovernorVerified,
} from '~/entities/vault'
import type { ChainVaultsSnapshot, VerificationLabels } from '~/entities/vault'

const CACHE_TTL_MS = 300_000

const VERIFIED_ARRAY_ABI = [{
  type: 'function',
  name: 'verifiedArray',
  stateMutability: 'view',
  inputs: [],
  outputs: [{ type: 'address[]' }],
}] as const

interface ProductEntry {
  vaults?: unknown
  deprecatedVaults?: unknown
  entity?: unknown
}

interface EntityEntry {
  addresses?: unknown
}

interface EarnVaultEntryObject {
  address?: unknown
  deprecated?: unknown
}

interface EulerChainConfig {
  chainId?: unknown
  addresses?: {
    peripheryAddrs?: {
      escrowedCollateralPerspective?: unknown
    }
  }
}

const cache = createTtlCache<Set<string>>({ ttlMs: CACHE_TTL_MS, maxEntries: 64 })
const inflight = new Map<number, Promise<Set<string>>>()

function tryChecksum(value: unknown): Address | null {
  if (typeof value !== 'string') return null
  try {
    return getAddress(value)
  }
  catch {
    return null
  }
}

async function fetchLabels<T>(
  chainId: number,
  file: 'products.json' | 'entities.json' | 'earn-vaults.json',
): Promise<T> {
  return await $fetch<T>(`/api/labels/${file}`, { query: { chainId }, headers: INTERNAL_FETCH_HEADERS })
}

async function fetchEulerChains(): Promise<EulerChainConfig[]> {
  const data = await $fetch<unknown>('/api/euler-chains', { headers: INTERNAL_FETCH_HEADERS })
  return Array.isArray(data) ? data as EulerChainConfig[] : []
}

async function fetchEscrowAddresses(chainId: number): Promise<string[]> {
  const rpcUrl = resolveRpcUrl(chainId)
  if (!rpcUrl) return []

  const chains = await fetchEulerChains()
  const config = chains.find(c => c.chainId === chainId)
  const perspective = config?.addresses?.peripheryAddrs?.escrowedCollateralPerspective
  if (typeof perspective !== 'string' || !perspective.startsWith('0x')) return []

  const callData = encodeFunctionData({ abi: VERIFIED_ARRAY_ABI, functionName: 'verifiedArray' })
  const payload = JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'eth_call',
    params: [{ to: perspective, data: callData }, 'latest'],
  })

  const response = await fetchWithTimeout(rpcUrl, 10_000, {
    method: 'POST',
    body: payload,
    headers: { 'content-type': 'application/json' },
  })

  if (!response.ok) throw new Error(`Upstream RPC returned ${response.status}`)

  const parsed = await response.json() as { result?: unknown, error?: unknown }
  if (parsed.error) throw new Error(`Upstream RPC error: ${JSON.stringify(parsed.error)}`)
  const result = parsed.result
  if (typeof result !== 'string' || !result.startsWith('0x')) return []

  const decoded = decodeFunctionResult({
    abi: VERIFIED_ARRAY_ABI,
    functionName: 'verifiedArray',
    data: result as `0x${string}`,
  })
  return [...decoded]
}

async function loadSnapshot(chainId: number): Promise<ChainVaultsSnapshot> {
  const key = String(chainId)
  const cached = vaultsCache.get(key) ?? vaultsCache.getStale(key)
  const serialised = cached ?? await refreshChainVaults(chainId)
  return deserialiseSnapshot(serialised)
}

interface ProductMaps {
  /** address → declared entity keys for the product owning that address. Includes deprecated vaults to mirror client's `getProductByVault`. */
  declaredKeysByVault: Map<Address, string[]>
  /** Addresses listed under any product's `deprecatedVaults`. Used for the server's last-step deprecated-as-unknown filter. */
  deprecatedSet: Set<Address>
}

function declaredKeysOf(rawEntity: unknown): string[] {
  if (Array.isArray(rawEntity)) {
    return rawEntity.filter((v): v is string => typeof v === 'string')
  }
  return typeof rawEntity === 'string' ? [rawEntity] : []
}

// Builds the map used by `getDeclaredEntityKeys`, plus the set of deprecated
// addresses. Including deprecated vaults in the map mirrors the client's
// `getProductByVault` (which checks both `vaults` and `deprecatedVaults`) so
// the shared verification function sees identical inputs across both call
// sites; the deprecated set is applied as a separate, server-only last step.
function buildProductMaps(products: Record<string, ProductEntry>): ProductMaps {
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

function buildDeprecatedEarnSet(entries: unknown[]): Set<Address> {
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

function buildEntityAddressMap(
  entities: Record<string, EntityEntry>,
): Record<string, { addresses: Record<string, unknown> }> {
  const result: Record<string, { addresses: Record<string, unknown> }> = {}
  for (const [key, entity] of Object.entries(entities)) {
    const raw = entity.addresses
    const addresses: Record<string, unknown> = {}
    if (raw && typeof raw === 'object') {
      for (const [addr, label] of Object.entries(raw)) {
        const checksum = tryChecksum(addr)
        if (checksum) addresses[checksum] = label
      }
    }
    result[key] = { addresses }
  }
  return result
}

async function buildVerifiedSet(chainId: number): Promise<Set<string>> {
  const [products, entities, earn, escrow, snapshot] = await Promise.allSettled([
    fetchLabels<Record<string, ProductEntry>>(chainId, 'products.json'),
    fetchLabels<Record<string, EntityEntry>>(chainId, 'entities.json'),
    fetchLabels<unknown[]>(chainId, 'earn-vaults.json'),
    fetchEscrowAddresses(chainId),
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
  const entitiesByKey = buildEntityAddressMap(entities.value ?? {})

  const deprecatedEarnSet = earn.status === 'fulfilled' && Array.isArray(earn.value)
    ? buildDeprecatedEarnSet(earn.value)
    : new Set<Address>()
  if (earn.status === 'rejected') {
    logger.warn({ ctx: 'verified-vaults', chainId, err: earn.reason }, 'earn-vaults fetch failed')
  }

  const labels: VerificationLabels = {
    entitiesByKey,
    getDeclaredEntityKeys: (addr) => {
      const checksum = tryChecksum(addr)
      if (!checksum) return undefined
      return declaredKeysByVault.get(checksum)
    },
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
