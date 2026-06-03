import type { Address } from 'viem'
import { createTtlCache } from './cache'
import { tryChecksum } from './labels-helpers'
import {
  buildLabelsView,
  type EntityEntryFull,
  type LabelsView,
} from './labels-view'
import { logger } from './logger'
import { refreshVerifiedAddressSet } from './verified-vaults'
import {
  resolveEarnGoverningEntityKeys,
  resolveGoverningEntityKeys,
} from '~/utils/vault/governor-verification'
import type { EulerEarn, EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'

interface VaultAsset {
  address: string
  symbol: string
  name: string
  decimals: number
}

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
  url: string | null
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
  /** True when the owning product has `isGovernanceLimited: true` (governor exists but no active risk management). False for vaults without a product. */
  governanceLimited: boolean
  /** The owning product slug from products.json (e.g. "euler-prime"), or null for vaults outside any product (escrow, earn-only entries, governor mismatch with no product). */
  productId: string | null
  asset: AssetInfo | null
  /** All declared product entities whose `addresses` contain the vault's on-chain governor (or owner, for Earn). Empty when no entity matches, the vault is escrow, or the vault is unverified. Multiple entries can occur when a product declares multiple entities and more than one matches. */
  entities: EntityInfo[]
}

interface BuildContext {
  chainId: number
  verifiedSet: Set<string>
  view: LabelsView
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
  const url = strOrNull(entity.url)
  return {
    name,
    logo: logoFile ? entityLogoUrl(logoFile) : '',
    description: strOrNull(entity.description),
    url: url && /^https?:\/\//i.test(url) ? url : null,
  }
}

function vaultName(vault: EVault | SecuritizeCollateralVault | EulerEarn): string {
  return strOrEmpty(vault.shares?.name) || strOrEmpty(vault.asset?.name)
}

function buildEvkMetadata(
  vault: EVault | SecuritizeCollateralVault,
  type: 'evk' | 'securitize',
  ctx: BuildContext,
): VaultMetadata | null {
  const addr = tryChecksum(vault.address)
  if (!addr) return null

  // Defensive escrow short-circuit: if an escrow address slips into the EVK
  // list (the loader puts them in `escrowVaults`, but a future reshuffle of
  // the snapshot could leak one), render it the same way buildEscrowMetadata
  // would. Mirrors isVaultGovernorVerified's `vaultCategory === 'escrow'` guard.
  if (ctx.view.escrowAddresses.has(addr) || ('vaultCategory' in vault && vault.vaultCategory === 'escrow')) {
    return buildEscrowMetadata(addr, vault as EVault, ctx)
  }

  const verified = ctx.verifiedSet.has(addr)
  const deprecated = ctx.view.deprecatedSet.has(addr)
  const product = ctx.view.productByVault.get(addr)
  const override = product?.vaultOverrides[addr]

  // Label-derived display fields (name, description, portfolioNotice,
  // deprecationReason) are sourced from labels regardless of verified
  // status — they are authoritative content set by the team that listed
  // the vault. On-chain ERC-20 name is only a fallback when labels carry
  // no name. Verification (governor match) only gates `entities` resolution
  // below, which is the security-sensitive "who manages this vault" claim.
  const labelName = strOrNull(override?.name) ?? (product?.name || null)
  const description = strOrNull(override?.description) ?? product?.description ?? null
  const portfolioNotice = strOrNull(override?.portfolioNotice) ?? product?.portfolioNotice ?? null
  const deprecationReason = strOrNull(override?.deprecationReason) ?? product?.deprecationReason ?? null

  const entityKeys = verified ? resolveGoverningEntityKeys(vault, ctx.view.verificationLabels) : []
  const entities = entityKeys
    .map(key => buildEntityInfo(key, ctx.view.entitiesRaw))
    .filter((e): e is EntityInfo => e !== null)

  return {
    chainId: ctx.chainId,
    address: addr,
    type,
    name: labelName ?? vaultName(vault),
    description,
    portfolioNotice,
    deprecationReason,
    deprecated,
    governanceLimited: product?.isGovernanceLimited === true,
    productId: product?.slug ?? null,
    asset: buildAsset(vault.asset, ctx.view.tokenLogos),
    entities,
  }
}

function buildEarnMetadata(vault: EulerEarn, ctx: BuildContext): VaultMetadata | null {
  const addr = tryChecksum(vault.address)
  if (!addr) return null

  const verified = ctx.verifiedSet.has(addr)
  const deprecated = ctx.view.deprecatedSet.has(addr) || ctx.view.deprecatedEarnSet.has(addr)
  const earnEntry = ctx.view.earnByAddr.get(addr)
  const product = ctx.view.productByVault.get(addr)

  // Same rationale as buildEvkMetadata: label fields are authoritative
  // content. `verified` only gates `entities` resolution.
  const labelName = product?.name || null
  const description = strOrNull(earnEntry?.description) ?? product?.description ?? null
  const portfolioNotice = strOrNull(earnEntry?.portfolioNotice) ?? product?.portfolioNotice ?? null
  const deprecationReason = strOrNull(earnEntry?.deprecationReason) ?? product?.deprecationReason ?? null

  const entityKeys = verified ? resolveEarnGoverningEntityKeys(vault, ctx.view.verificationLabels) : []
  const entities = entityKeys
    .map(key => buildEntityInfo(key, ctx.view.entitiesRaw))
    .filter((e): e is EntityInfo => e !== null)

  return {
    chainId: ctx.chainId,
    address: addr,
    type: 'earn',
    name: labelName ?? vaultName(vault),
    description,
    portfolioNotice,
    deprecationReason,
    deprecated,
    governanceLimited: product?.isGovernanceLimited === true,
    productId: product?.slug ?? null,
    asset: buildAsset(vault.asset, ctx.view.tokenLogos),
    entities,
  }
}

function buildEscrowMetadata(
  addr: Address,
  vault: EVault | undefined,
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
    governanceLimited: false,
    productId: null,
    asset: vault ? buildAsset(vault.asset, ctx.view.tokenLogos) : null,
    entities: [],
  }
}

function computeMetadata(ctx: BuildContext): Map<string, VaultMetadata> {
  const result = new Map<string, VaultMetadata>()

  for (const vault of ctx.view.snapshot.evkVaults) {
    const entry = buildEvkMetadata(vault, 'evk', ctx)
    if (entry) result.set(entry.address, entry)
  }
  for (const vault of ctx.view.snapshot.securitizeVaults) {
    const entry = buildEvkMetadata(vault, 'securitize', ctx)
    if (entry) result.set(entry.address, entry)
  }
  for (const vault of ctx.view.snapshot.earnVaults) {
    const entry = buildEarnMetadata(vault, ctx)
    if (entry) result.set(entry.address, entry)
  }

  // Escrow: union of perspective addresses + snapshot's escrow subset (the
  // latter carries asset data for the referenced collateral vaults). Any
  // escrow address outside the snapshot subset gets a thin entry with
  // asset:null — known v1 limitation.
  const escrowFromSnapshot = new Map<Address, EVault>()
  for (const v of ctx.view.snapshot.escrowVaults) {
    const addr = tryChecksum(v.address)
    if (addr) escrowFromSnapshot.set(addr, v)
  }
  const allEscrow = new Set<Address>()
  for (const a of ctx.view.escrowAddresses) allEscrow.add(a)
  for (const a of escrowFromSnapshot.keys()) allEscrow.add(a)
  for (const addr of allEscrow) {
    const entry = buildEscrowMetadata(addr, escrowFromSnapshot.get(addr), ctx)
    result.set(addr, entry)
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
export async function refreshChainVaultMetadata(chainId: number): Promise<Map<string, VaultMetadata>> {
  const key = String(chainId)
  const pending = inflight.get(chainId)
  if (pending) return pending

  const task = (async () => {
    try {
      // Both fetches are deduped: refreshVerifiedAddressSet internally also
      // calls buildLabelsView and the in-flight registry collapses them onto
      // a single upstream pass.
      const [view, verifiedSet] = await Promise.all([
        buildLabelsView(chainId),
        refreshVerifiedAddressSet(chainId),
      ])
      const map = computeMetadata({ chainId, view, verifiedSet })
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

export async function getChainVaultMetadata(chainId: number): Promise<Map<string, VaultMetadata>> {
  const fresh = cache.get(String(chainId))
  if (fresh) return fresh
  return refreshChainVaultMetadata(chainId)
}
