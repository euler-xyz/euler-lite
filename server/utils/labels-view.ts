/**
 * Per-chain "labels view" — the substrate both /api/public/is-known and
 * /api/public/metadata derive from. Folds the snapshot + label files + escrow
 * perspective + token list into one shape with all the derived maps pre-built:
 *
 *   - snapshot                    (vault data)
 *   - productByVault              (address → product descriptor; includes deprecated vaults)
 *   - deprecatedSet               (addresses listed under deprecatedVaults[])
 *   - earnByAddr / deprecatedEarnSet
 *   - escrowAddresses             (Set form of escrow perspective)
 *   - entitiesRaw                 (kept for downstream EntityInfo composition)
 *   - tokenLogos
 *   - verificationLabels          (the shape the shared rule consumes)
 *
 * In-flight dedup collapses concurrent rebuilds onto a single upstream pass.
 * No TTL cache here — the underlying snapshot / labels / token-list / escrow
 * already cache, and each consumer (verified-vaults, vault-metadata) keeps
 * its own final-shape cache, so an extra layer between them adds no value.
 */
import type { Address } from 'viem'
import { createInFlightDedup } from './in-flight'
import { fetchEscrowPerspectiveAddresses } from './escrow-perspective'
import { INTERNAL_FETCH_HEADERS } from './internal-headers'
import {
  buildEntityAddressSets,
  declaredKeysOf,
  fetchLabels,
  tryChecksum,
  type EntityEntry,
} from './labels-helpers'
import { logger } from './logger'
import { refreshChainVaults, vaultsCache } from './vaults-cache'
import { deserialiseSnapshot } from '~/entities/vault'
import type { ChainVaultsSnapshot, VerificationLabels } from '~/entities/vault'

export interface ProductEntryFull {
  name?: unknown
  description?: unknown
  portfolioNotice?: unknown
  deprecationReason?: unknown
  entity?: unknown
  vaults?: unknown
  deprecatedVaults?: unknown
  vaultOverrides?: unknown
  isGovernanceLimited?: unknown
}

export interface VaultOverride {
  name?: unknown
  description?: unknown
  portfolioNotice?: unknown
  deprecationReason?: unknown
}

export interface EntityEntryFull extends EntityEntry {
  name?: unknown
  logo?: unknown
  description?: unknown
  url?: unknown
}

export interface EarnVaultEntry {
  address?: unknown
  description?: unknown
  portfolioNotice?: unknown
  deprecationReason?: unknown
  deprecated?: unknown
}

interface TokenListResponse {
  tokens?: TokenListEntry[]
}

interface TokenListEntry {
  address?: string
  logoURI?: string
}

export interface ProductDescriptor {
  slug: string
  name: string
  description: string | null
  portfolioNotice: string | null
  deprecationReason: string | null
  isGovernanceLimited: boolean
  entityKeys: string[]
  vaultOverrides: Record<string, VaultOverride>
}

export interface LabelsView {
  chainId: number
  snapshot: ChainVaultsSnapshot
  productByVault: Map<Address, ProductDescriptor>
  deprecatedSet: Set<Address>
  earnByAddr: Map<Address, EarnVaultEntry>
  deprecatedEarnSet: Set<Address>
  escrowAddresses: Set<Address>
  entitiesRaw: Record<string, EntityEntryFull>
  tokenLogos: Map<string, string>
  verificationLabels: VerificationLabels
}

const inflight = createInFlightDedup<number, LabelsView>()

function strOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.length > 0 ? value : null
}

function strOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  }
  catch {
    return false
  }
}

async function fetchTokenList(chainId: number): Promise<TokenListEntry[]> {
  const data = await $fetch<TokenListResponse>('/api/token-list', {
    query: { chainId },
    headers: INTERNAL_FETCH_HEADERS,
  })
  return Array.isArray(data?.tokens) ? data.tokens : []
}

async function loadSnapshot(chainId: number): Promise<ChainVaultsSnapshot> {
  const key = String(chainId)
  const cached = vaultsCache.get(key) ?? vaultsCache.getStale(key)
  const serialised = cached ?? await refreshChainVaults(chainId)
  return deserialiseSnapshot(serialised)
}

function buildProductDescriptors(products: Record<string, ProductEntryFull>): {
  productByVault: Map<Address, ProductDescriptor>
  deprecatedSet: Set<Address>
} {
  const productByVault = new Map<Address, ProductDescriptor>()
  const deprecatedSet = new Set<Address>()
  for (const [slug, product] of Object.entries(products)) {
    const overrides: Record<string, VaultOverride> = {}
    if (product.vaultOverrides && typeof product.vaultOverrides === 'object') {
      for (const [k, v] of Object.entries(product.vaultOverrides as Record<string, unknown>)) {
        const addr = tryChecksum(k)
        if (addr && v && typeof v === 'object') {
          overrides[addr] = v as VaultOverride
        }
      }
    }
    const desc: ProductDescriptor = {
      slug,
      name: strOrEmpty(product.name),
      description: strOrNull(product.description),
      portfolioNotice: strOrNull(product.portfolioNotice),
      deprecationReason: strOrNull(product.deprecationReason),
      isGovernanceLimited: product.isGovernanceLimited === true,
      entityKeys: declaredKeysOf(product.entity),
      vaultOverrides: overrides,
    }
    // Include both vaults and deprecatedVaults so the shared verification rule
    // sees the same product context the client's getProductByVault does.
    if (Array.isArray(product.vaults)) {
      for (const v of product.vaults) {
        const addr = tryChecksum(v)
        if (addr) productByVault.set(addr, desc)
      }
    }
    if (Array.isArray(product.deprecatedVaults)) {
      for (const v of product.deprecatedVaults) {
        const addr = tryChecksum(v)
        if (addr) {
          productByVault.set(addr, desc)
          deprecatedSet.add(addr)
        }
      }
    }
  }
  return { productByVault, deprecatedSet }
}

function buildEarnEntryMap(entries: unknown[]): {
  earnByAddr: Map<Address, EarnVaultEntry>
  deprecatedEarnSet: Set<Address>
} {
  const earnByAddr = new Map<Address, EarnVaultEntry>()
  const deprecatedEarnSet = new Set<Address>()
  for (const entry of entries) {
    if (entry && typeof entry === 'object') {
      const obj = entry as EarnVaultEntry
      const addr = tryChecksum(obj.address)
      if (!addr) continue
      earnByAddr.set(addr, obj)
      if (obj.deprecated === true) deprecatedEarnSet.add(addr)
    }
  }
  return { earnByAddr, deprecatedEarnSet }
}

export function buildTokenLogoMap(tokens: TokenListEntry[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const t of tokens) {
    if (typeof t?.address !== 'string') continue
    if (typeof t.logoURI !== 'string' || t.logoURI.length === 0) continue
    if (!isHttpUrl(t.logoURI)) continue
    const lower = t.address.toLowerCase()
    if (!map.has(lower)) map.set(lower, t.logoURI)
  }
  return map
}

async function assembleLabelsView(chainId: number): Promise<LabelsView> {
  const [products, entities, earn, escrow, snapshot, tokens] = await Promise.allSettled([
    fetchLabels<Record<string, ProductEntryFull>>(chainId, 'products.json'),
    fetchLabels<Record<string, EntityEntryFull>>(chainId, 'entities.json'),
    fetchLabels<unknown[]>(chainId, 'earn-vaults.json'),
    fetchEscrowPerspectiveAddresses(chainId),
    loadSnapshot(chainId),
    fetchTokenList(chainId),
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

  const { productByVault, deprecatedSet } = buildProductDescriptors(products.value ?? {})
  const { earnByAddr, deprecatedEarnSet } = earn.status === 'fulfilled' && Array.isArray(earn.value)
    ? buildEarnEntryMap(earn.value)
    : { earnByAddr: new Map<Address, EarnVaultEntry>(), deprecatedEarnSet: new Set<Address>() }
  if (earn.status === 'rejected') {
    logger.warn({ ctx: 'labels-view', chainId, err: earn.reason }, 'earn-vaults fetch failed')
  }

  const escrowAddresses = new Set<Address>()
  if (escrow.status === 'fulfilled') {
    for (const a of escrow.value) {
      const addr = tryChecksum(a)
      if (addr) escrowAddresses.add(addr)
    }
  }
  else {
    logger.warn({ ctx: 'labels-view', chainId, err: escrow.reason }, 'escrow fetch failed')
  }

  const tokenLogos = tokens.status === 'fulfilled'
    ? buildTokenLogoMap(tokens.value)
    : new Map<string, string>()
  if (tokens.status === 'rejected') {
    logger.warn({ ctx: 'labels-view', chainId, err: tokens.reason }, 'token-list fetch failed')
  }

  const entitiesRaw = entities.value ?? {}
  const entityAddresses = buildEntityAddressSets(entitiesRaw)

  const verificationLabels: VerificationLabels = {
    getDeclaredEntityKeys: (addr) => {
      const checksum = tryChecksum(addr)
      if (!checksum) return undefined
      return productByVault.get(checksum)?.entityKeys
    },
    hasEntityAddress: (key, addr) => entityAddresses.get(key)?.has(addr) ?? false,
  }

  return {
    chainId,
    snapshot: snapshot.value,
    productByVault,
    deprecatedSet,
    earnByAddr,
    deprecatedEarnSet,
    escrowAddresses,
    entitiesRaw,
    tokenLogos,
    verificationLabels,
  }
}

export async function buildLabelsView(chainId: number): Promise<LabelsView> {
  return inflight.run(chainId, () => assembleLabelsView(chainId))
}
