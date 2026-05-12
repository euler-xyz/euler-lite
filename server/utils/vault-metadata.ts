import type { Address } from 'viem'
import { createTtlCache } from './cache'
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
import { getVerifiedAddressSet } from './verified-vaults'
import {
  deserialiseSnapshot,
  resolveEarnGoverningEntityKey,
  resolveGoverningEntityKey,
} from '~/entities/vault'
import type {
  ChainVaultsSnapshot,
  EarnVault,
  SecuritizeVault,
  Vault,
  VaultAsset,
  VerificationLabels,
} from '~/entities/vault'

const CACHE_TTL_MS = 300_000
const ESCROW_VAULT_NAME = 'Escrowed collateral'

export interface AssetInfo {
  address: string
  symbol: string
  name: string
  decimals: number
  url: string | null
}

export interface EntityInfo {
  name: string
  logo: string
  description: string | null
}

export interface VaultMetadata {
  chainId: number
  address: string
  type: 'evk' | 'securitize' | 'earn'
  name: string
  description: string | null
  portfolioNotice: string | null
  deprecationReason: string | null
  /** True if the vault is listed under any product's `deprecatedVaults` (or earn-vaults `deprecated: true`). */
  deprecated: boolean
  asset: AssetInfo | null
  entity: EntityInfo | null
}

interface ProductEntryFull {
  name?: unknown
  description?: unknown
  portfolioNotice?: unknown
  deprecationReason?: unknown
  entity?: unknown
  vaults?: unknown
  deprecatedVaults?: unknown
  vaultOverrides?: unknown
}

interface VaultOverride {
  name?: unknown
  description?: unknown
  portfolioNotice?: unknown
  deprecationReason?: unknown
}

interface EntityEntryFull extends EntityEntry {
  name?: unknown
  logo?: unknown
  description?: unknown
}

interface EarnVaultEntry {
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

interface ProductDescriptor {
  name: string
  description: string | null
  portfolioNotice: string | null
  deprecationReason: string | null
  entityKeys: string[]
  vaultOverrides: Record<string, VaultOverride>
}

interface BuildContext {
  chainId: number
  verifiedSet: Set<string>
  productByVault: Map<Address, ProductDescriptor>
  deprecatedSet: Set<Address>
  earnByAddr: Map<Address, EarnVaultEntry>
  deprecatedEarnSet: Set<Address>
  escrowAddresses: Set<Address>
  entities: Record<string, EntityEntryFull>
  labels: VerificationLabels
  tokenLogos: Map<string, string>
}

const cache = createTtlCache<Map<string, VaultMetadata>>({ ttlMs: CACHE_TTL_MS, maxEntries: 64 })
const inflight = new Map<number, Promise<Map<string, VaultMetadata>>>()

function strOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null
  return value.length > 0 ? value : null
}

function strOrEmpty(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

function resolveLabelsBaseUrl(): string {
  const explicit = (process.env.NUXT_PUBLIC_CONFIG_LABELS_BASE_URL || '').trim().replace(/\/+$/, '')
  if (explicit) return explicit
  const repo = process.env.NUXT_PUBLIC_CONFIG_LABELS_REPO || 'euler-xyz/euler-labels'
  const branch = process.env.NUXT_PUBLIC_CONFIG_LABELS_REPO_BRANCH || 'master'
  return `https://raw.githubusercontent.com/${repo}/refs/heads/${branch}`
}

function entityLogoUrl(fileName: string): string {
  return `${resolveLabelsBaseUrl()}/logo/${fileName}`
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
  for (const product of Object.values(products)) {
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
      name: strOrEmpty(product.name),
      description: strOrNull(product.description),
      portfolioNotice: strOrNull(product.portfolioNotice),
      deprecationReason: strOrNull(product.deprecationReason),
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

function buildTokenLogoMap(tokens: TokenListEntry[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const t of tokens) {
    if (typeof t?.address !== 'string') continue
    if (typeof t.logoURI !== 'string' || t.logoURI.length === 0) continue
    const lower = t.address.toLowerCase()
    if (!map.has(lower)) map.set(lower, t.logoURI)
  }
  return map
}

function buildAsset(asset: VaultAsset | undefined, tokenLogos: Map<string, string>): AssetInfo | null {
  if (!asset) return null
  const addr = tryChecksum(asset.address)
  if (!addr) return null
  return {
    address: addr,
    symbol: strOrEmpty(asset.symbol),
    name: strOrEmpty(asset.name),
    decimals: Number(asset.decimals),
    url: tokenLogos.get(asset.address.toLowerCase()) ?? null,
  }
}

function buildEntityInfo(entityKey: string, entities: Record<string, EntityEntryFull>): EntityInfo | null {
  const entity = entities[entityKey]
  if (!entity) return null
  const name = strOrEmpty(entity.name)
  const logoFile = strOrEmpty(entity.logo)
  if (!name && !logoFile) return null
  return {
    name,
    logo: logoFile ? entityLogoUrl(logoFile) : '',
    description: strOrNull(entity.description),
  }
}

function buildEvkMetadata(
  vault: Vault | SecuritizeVault,
  type: 'evk' | 'securitize',
  ctx: BuildContext,
): VaultMetadata | null {
  const addr = tryChecksum(vault.address)
  if (!addr) return null

  // Defensive escrow short-circuit: if an escrow address slips into the EVK
  // list (the loader puts them in `escrowVaults`, but a future reshuffle of
  // the snapshot could leak one), render it the same way buildEscrowMetadata
  // would. Mirrors isVaultGovernorVerified's `vaultCategory === 'escrow'` guard.
  if (ctx.escrowAddresses.has(addr) || ('vaultCategory' in vault && vault.vaultCategory === 'escrow')) {
    return buildEscrowMetadata(addr, vault as Vault, ctx)
  }

  const verified = ctx.verifiedSet.has(addr)
  const deprecated = ctx.deprecatedSet.has(addr)
  const product = ctx.productByVault.get(addr)
  const override = product?.vaultOverrides[addr]

  // `deprecationReason` is sourced from labels regardless of verified status:
  // a deprecated entry is authoritative content (it tells callers why the
  // vault was retired), and there is no risk-management implication to expose.
  const deprecationReason = strOrNull(override?.deprecationReason) ?? product?.deprecationReason ?? null

  const labelName = verified ? (strOrNull(override?.name) ?? (product?.name || null)) : null
  const description = verified ? (strOrNull(override?.description) ?? product?.description ?? null) : null
  const portfolioNotice = verified ? (strOrNull(override?.portfolioNotice) ?? product?.portfolioNotice ?? null) : null

  const entityKey = verified ? resolveGoverningEntityKey(vault, ctx.labels) : null
  const entity = entityKey ? buildEntityInfo(entityKey, ctx.entities) : null

  return {
    chainId: ctx.chainId,
    address: addr,
    type,
    name: labelName ?? strOrEmpty(vault.name),
    description,
    portfolioNotice,
    deprecationReason,
    deprecated,
    asset: buildAsset(vault.asset, ctx.tokenLogos),
    entity,
  }
}

function buildEarnMetadata(vault: EarnVault, ctx: BuildContext): VaultMetadata | null {
  const addr = tryChecksum(vault.address)
  if (!addr) return null

  const verified = ctx.verifiedSet.has(addr)
  const deprecated = ctx.deprecatedSet.has(addr) || ctx.deprecatedEarnSet.has(addr)
  const earnEntry = ctx.earnByAddr.get(addr)
  const product = ctx.productByVault.get(addr)

  const deprecationReason = strOrNull(earnEntry?.deprecationReason) ?? product?.deprecationReason ?? null

  const labelName = verified ? (product?.name || null) : null
  const description = verified ? (strOrNull(earnEntry?.description) ?? product?.description ?? null) : null
  const portfolioNotice = verified ? (strOrNull(earnEntry?.portfolioNotice) ?? product?.portfolioNotice ?? null) : null

  const entityKey = verified ? resolveEarnGoverningEntityKey(vault, ctx.labels) : null
  const entity = entityKey ? buildEntityInfo(entityKey, ctx.entities) : null

  return {
    chainId: ctx.chainId,
    address: addr,
    type: 'earn',
    name: labelName ?? strOrEmpty(vault.name),
    description,
    portfolioNotice,
    deprecationReason,
    deprecated,
    asset: buildAsset(vault.asset, ctx.tokenLogos),
    entity,
  }
}

function buildEscrowMetadata(
  addr: Address,
  vault: Vault | undefined,
  ctx: BuildContext,
): VaultMetadata {
  return {
    chainId: ctx.chainId,
    address: addr,
    type: 'evk',
    name: ESCROW_VAULT_NAME,
    description: null,
    portfolioNotice: null,
    deprecationReason: null,
    deprecated: false,
    asset: vault ? buildAsset(vault.asset, ctx.tokenLogos) : null,
    entity: null,
  }
}

async function buildChainMetadata(chainId: number): Promise<Map<string, VaultMetadata>> {
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
    logger.warn({ ctx: 'vault-metadata', chainId, err: earn.reason }, 'earn-vaults fetch failed')
  }

  const escrowAddresses = new Set<Address>()
  if (escrow.status === 'fulfilled') {
    for (const a of escrow.value) {
      const addr = tryChecksum(a)
      if (addr) escrowAddresses.add(addr)
    }
  }
  else {
    logger.warn({ ctx: 'vault-metadata', chainId, err: escrow.reason }, 'escrow fetch failed')
  }

  const tokenLogos = tokens.status === 'fulfilled'
    ? buildTokenLogoMap(tokens.value)
    : new Map<string, string>()
  if (tokens.status === 'rejected') {
    logger.warn({ ctx: 'vault-metadata', chainId, err: tokens.reason }, 'token-list fetch failed')
  }

  const entitiesValue = entities.value ?? {}
  const entityAddresses = buildEntityAddressSets(entitiesValue)

  const verificationLabels: VerificationLabels = {
    getDeclaredEntityKeys: (addr) => {
      const checksum = tryChecksum(addr)
      if (!checksum) return undefined
      return productByVault.get(checksum)?.entityKeys
    },
    hasEntityAddress: (key, addr) => entityAddresses.get(key)?.has(addr) ?? false,
  }

  const verifiedSet = await getVerifiedAddressSet(chainId)

  const ctx: BuildContext = {
    chainId,
    verifiedSet,
    productByVault,
    deprecatedSet,
    earnByAddr,
    deprecatedEarnSet,
    escrowAddresses,
    entities: entitiesValue,
    labels: verificationLabels,
    tokenLogos,
  }

  const result = new Map<string, VaultMetadata>()

  for (const vault of snapshot.value.evkVaults) {
    const entry = buildEvkMetadata(vault, 'evk', ctx)
    if (entry) result.set(entry.address, entry)
  }
  for (const vault of snapshot.value.securitizeVaults) {
    const entry = buildEvkMetadata(vault, 'securitize', ctx)
    if (entry) result.set(entry.address, entry)
  }
  for (const vault of snapshot.value.earnVaults) {
    const entry = buildEarnMetadata(vault, ctx)
    if (entry) result.set(entry.address, entry)
  }

  // Escrow: union of perspective addresses + snapshot's escrow subset (the
  // latter carries asset data for the referenced collateral vaults). Any
  // escrow address outside the snapshot subset gets a thin entry with
  // asset:null — known v1 limitation.
  const escrowFromSnapshot = new Map<Address, Vault>()
  for (const v of snapshot.value.escrowVaults) {
    const addr = tryChecksum(v.address)
    if (addr) escrowFromSnapshot.set(addr, v)
  }
  const allEscrow = new Set<Address>()
  for (const a of escrowAddresses) allEscrow.add(a)
  for (const a of escrowFromSnapshot.keys()) allEscrow.add(a)
  for (const addr of allEscrow) {
    const entry = buildEscrowMetadata(addr, escrowFromSnapshot.get(addr), ctx)
    result.set(addr, entry)
  }

  return result
}

export async function getChainVaultMetadata(chainId: number): Promise<Map<string, VaultMetadata>> {
  const key = String(chainId)
  const fresh = cache.get(key)
  if (fresh) return fresh

  const pending = inflight.get(chainId)
  if (pending) return pending

  const task = (async () => {
    try {
      const map = await buildChainMetadata(chainId)
      cache.set(key, map)
      return map
    }
    catch (err) {
      logger.warn({ ctx: 'vault-metadata', chainId, err }, 'rebuild failed')
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
