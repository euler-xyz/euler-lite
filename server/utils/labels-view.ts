/**
 * Per-chain "labels view" shared by /api/public/is-known and
 * /api/public/metadata. It keeps Lite's public API/cache policy in the app,
 * but sources normalized labels and vault entities through the SDK.
 */
import {
  StandardEVaultPerspectives,
  VaultType,
  type EulerEarn,
  type EulerLabelEarnVaultEntry,
  type EulerLabelEntity,
  type EulerLabelProduct,
  type EulerLabelsData,
  type EulerSDK,
  type EVault,
  type SecuritizeCollateralVault,
} from '@eulerxyz/euler-v2-sdk'
import type { Address } from 'viem'
import { createInFlightDedup } from './in-flight'
import { buildEntityAddressSets, declaredKeysOf, tryChecksum } from './labels-helpers'
import { logger } from './logger'
import { getServerSdk } from './sdk-server'
import type { VerificationLabels } from '~/utils/vault/governor-verification'

export interface ChainVaultsSnapshot {
  evkVaults: EVault[]
  securitizeVaults: SecuritizeCollateralVault[]
  earnVaults: EulerEarn[]
  escrowVaults: EVault[]
}

export type ProductEntryFull = EulerLabelProduct

export interface VaultOverride {
  name?: unknown
  description?: unknown
  portfolioNotice?: unknown
  deprecationReason?: unknown
  tags?: unknown
}

export interface EntityEntryFull extends EulerLabelEntity {
  name: string
  logo: string
  description: string
  url: string
}

export interface EarnVaultEntry extends EulerLabelEarnVaultEntry {
  address: string
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
  governanceLimited: boolean
  forceUnverified: boolean
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

function uniqueAddresses(addresses: Iterable<string>): Address[] {
  const result = new Map<string, Address>()
  for (const address of addresses) {
    const checksummed = tryChecksum(address)
    if (checksummed) result.set(checksummed.toLowerCase(), checksummed)
  }
  return [...result.values()]
}

function hasTag(tags: unknown, tag: string): boolean {
  return Array.isArray(tags) && tags.includes(tag)
}

function overrideHasTag(
  overrides: Record<string, VaultOverride>,
  address: Address,
  tag: string,
): boolean {
  return hasTag(overrides[address]?.tags, tag)
}

// SDK builder shared with vaults-cache via server/utils/sdk-server.ts.
const getSdk = (chainId: number): Promise<EulerSDK> => getServerSdk(chainId)

async function fetchTokenList(chainId: number): Promise<TokenListEntry[]> {
  const data = await $fetch<TokenListResponse>('/api/token-list', { query: { chainId } })
  return Array.isArray(data?.tokens) ? data.tokens : []
}

export function buildProductDescriptors(products: Record<string, ProductEntryFull>): {
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
      governanceLimited: hasTag(product.tags, 'governance limited'),
      forceUnverified: strOrNull(product.deprecationReason)?.toLowerCase().includes('unrecognized entity') === true,
      entityKeys: declaredKeysOf(product.entity),
      vaultOverrides: overrides,
    }
    const descriptorForVault = (addr: Address): ProductDescriptor => ({
      ...desc,
      governanceLimited: desc.governanceLimited || overrideHasTag(overrides, addr, 'governance limited'),
    })
    for (const v of product.vaults ?? []) {
      const addr = tryChecksum(v)
      if (addr) productByVault.set(addr, descriptorForVault(addr))
    }
    for (const v of product.deprecatedVaults ?? []) {
      const addr = tryChecksum(v)
      if (addr) {
        productByVault.set(addr, descriptorForVault(addr))
        deprecatedSet.add(addr)
      }
    }
  }
  return { productByVault, deprecatedSet }
}

function buildEarnEntryMap(labels: EulerLabelsData): {
  earnByAddr: Map<Address, EarnVaultEntry>
  deprecatedEarnSet: Set<Address>
} {
  const earnByAddr = new Map<Address, EarnVaultEntry>()
  const deprecatedEarnSet = new Set<Address>()
  for (const entry of Object.values(labels.earnVaultEntries)) {
    const addr = tryChecksum(entry.address)
    if (!addr) continue
    earnByAddr.set(addr, entry as EarnVaultEntry)
  }
  for (const address of Object.keys(labels.deprecatedEarnVaults)) {
    const addr = tryChecksum(address)
    if (addr) deprecatedEarnSet.add(addr)
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

function withVaultMetadata<T extends object>(
  vault: T,
  metadata: { verified: true, vaultCategory?: 'standard' | 'escrow' },
): T {
  return Object.assign(vault, metadata)
}

async function buildSnapshot(
  chainId: number,
  sdk: EulerSDK,
  labels: EulerLabelsData,
): Promise<{ snapshot: ChainVaultsSnapshot, escrowAddresses: Set<Address> }> {
  const escrowAddresses = new Set<Address>(
    uniqueAddresses(await sdk.eVaultService.fetchVerifiedVaultAddresses(chainId, [StandardEVaultPerspectives.ESCROW])),
  )
  const candidates = uniqueAddresses([
    ...labels.verifiedVaultAddresses,
    ...labels.earnVaults,
  ])

  const types = candidates.length > 0
    ? await sdk.vaultMetaService.fetchVaultTypes(chainId, candidates)
    : {}

  const earnSet = new Set(uniqueAddresses(labels.earnVaults).map(addr => addr.toLowerCase()))
  const evkAddresses: Address[] = []
  const securitizeAddresses: Address[] = []
  const earnAddresses: Address[] = []

  for (const address of candidates) {
    const lower = address.toLowerCase()
    const type = types[address] ?? types[address.toLowerCase() as Address]
    if (type === VaultType.SecuritizeCollateral) {
      securitizeAddresses.push(address)
    }
    else if (type === VaultType.EulerEarn || earnSet.has(lower)) {
      earnAddresses.push(address)
    }
    else {
      evkAddresses.push(address)
    }
  }

  const vaultOptions = {
    populateMarketPrices: true,
    populateCollaterals: true,
    populateStrategyVaults: true,
    populateRewards: true,
    eVaultFetchOptions: {
      populateMarketPrices: true,
      populateCollaterals: true,
      populateRewards: true,
    },
  }

  const [evk, securitize, earn] = await Promise.all([
    evkAddresses.length ? sdk.eVaultService.fetchVaults(chainId, evkAddresses, vaultOptions) : { result: [], errors: [] },
    securitizeAddresses.length ? sdk.securitizeVaultService.fetchVaults(chainId, securitizeAddresses, { populateMarketPrices: true, populateRewards: true }) : { result: [], errors: [] },
    earnAddresses.length ? sdk.eulerEarnService.fetchVaults(chainId, earnAddresses, vaultOptions) : { result: [], errors: [] },
  ])

  for (const issue of [...evk.errors, ...securitize.errors, ...earn.errors]) {
    logger.warn({ ctx: 'labels-view', chainId, issue }, 'sdk vault fetch issue')
  }

  const evkVaults = (evk.result.filter(Boolean) as EVault[]).map(vault =>
    withVaultMetadata(vault, {
      verified: true,
      vaultCategory: escrowAddresses.has(vault.address) ? 'escrow' : 'standard',
    }),
  )
  const securitizeVaults = (securitize.result.filter(Boolean) as SecuritizeCollateralVault[])
    .map(vault => withVaultMetadata(vault, { verified: true }))
  const earnVaults = (earn.result.filter(Boolean) as EulerEarn[])
    .map(vault => withVaultMetadata(vault, { verified: true }))
  const referencedEscrowAddresses = uniqueAddresses(evkVaults.flatMap(vault =>
    (vault.collaterals ?? []).map(collateral => collateral.address).filter(address => escrowAddresses.has(address)),
  ).concat(earnVaults.flatMap(vault =>
    (vault.strategies ?? []).map(strategy => strategy.address).filter(address => escrowAddresses.has(address)),
  )))
  const fetchedEscrow = referencedEscrowAddresses.length
    ? await sdk.eVaultService.fetchVaults(chainId, referencedEscrowAddresses, vaultOptions)
    : { result: [], errors: [] }
  for (const issue of fetchedEscrow.errors) {
    logger.warn({ ctx: 'labels-view', chainId, issue }, 'sdk escrow fetch issue')
  }

  const escrowVaults = [
    ...evkVaults.filter(vault => escrowAddresses.has(vault.address)),
    ...(fetchedEscrow.result.filter(Boolean) as EVault[]),
  ].map(vault =>
    withVaultMetadata(vault, {
      verified: true,
      vaultCategory: 'escrow',
    }),
  )

  return {
    escrowAddresses,
    snapshot: {
      evkVaults,
      securitizeVaults,
      earnVaults,
      escrowVaults,
    },
  }
}

async function assembleLabelsView(chainId: number): Promise<LabelsView> {
  const sdk = await getSdk(chainId)
  const [labels, tokens] = await Promise.allSettled([
    sdk.eulerLabelsService.fetchEulerLabelsData(chainId),
    fetchTokenList(chainId),
  ])

  if (labels.status === 'rejected') {
    const reason = labels.reason instanceof Error ? labels.reason.message : String(labels.reason)
    throw new Error(`labels fetch failed: ${reason}`)
  }

  const { snapshot, escrowAddresses } = await buildSnapshot(chainId, sdk, labels.value)
  const { productByVault, deprecatedSet } = buildProductDescriptors(labels.value.products as Record<string, ProductEntryFull>)
  const { earnByAddr, deprecatedEarnSet } = buildEarnEntryMap(labels.value)

  const tokenLogos = tokens.status === 'fulfilled'
    ? buildTokenLogoMap(tokens.value)
    : new Map<string, string>()
  if (tokens.status === 'rejected') {
    logger.warn({ ctx: 'labels-view', chainId, err: tokens.reason }, 'token-list fetch failed')
  }

  const entitiesRaw = labels.value.entities as Record<string, EntityEntryFull>
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
    snapshot,
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
