import {
  hasPublishedVaultLabelContent,
  normalizePublicLabelsData as normalizeSdkPublicLabelsData,
  type EulerLabelAssetPatternRule,
  type PublicEulerLabelsData,
  type PublicLabelsSource,
} from '@eulerxyz/euler-v2-sdk/public-labels'
import { getAddress } from 'viem'
import type { EulerLabelAssetEntry, EulerLabelProduct } from '~/entities/euler/labels'

export {
  PUBLIC_LABELS_RUNTIME_VERSION,
} from '@eulerxyz/euler-v2-sdk/public-labels'

export type {
  PublicEntityAddress,
  PublicEntityLabel,
  PublicEulerLabelsData,
  PublicGeoPolicy,
  PublicLabelsMeta,
  PublicLabelsQuery,
  PublicLabelsRequest,
  PublicLabelsResponse,
  PublicLabelsSource,
  PublicProductLabel,
  PublicVaultCampaign,
  PublicVaultLabel,
} from '@eulerxyz/euler-v2-sdk/public-labels'

export const PUBLIC_LABELS_FIXTURE_VERSION = 'v20260804151305236'

export interface EffectiveProductPolicy {
  block?: string[]
  restricted?: string[]
  notExplorable?: boolean
  vaults?: string[]
  deprecatedVaults?: string[]
  vaultOverrides?: Record<string, {
    block?: string[]
    restricted?: string[]
    notExplorableLend?: boolean
    notExplorableBorrow?: boolean
  }>
}

export interface EffectiveEarnPolicy {
  address: string
  block?: string[]
  restricted?: string[]
  notExplorable?: boolean
}

/**
 * Effective visibility remains a separate compatibility contract until V3
 * publishes the resolved product/vault/asset policy result. No display
 * content is read from this source.
 */
export interface EffectiveLabelsSource {
  products: Record<string, EffectiveProductPolicy>
  earnVaults: Array<string | EffectiveEarnPolicy>
  assets: EulerLabelAssetEntry[]
}

export interface PublicLabelsBundle {
  /** Concrete immutable version used for every request in this aggregate. */
  version: string
  publicLabels: PublicLabelsSource
  effectivePolicy: EffectiveLabelsSource
}

const emptyEffectiveLabelsSource = (): EffectiveLabelsSource => ({
  products: {},
  earnVaults: [],
  assets: [],
})

const uniqueStrings = (values: Iterable<string>): string[] => [...new Set(values)]

const tryAddress = (value: string): string | undefined => {
  try {
    return getAddress(value)
  }
  catch {
    return undefined
  }
}

const getEffectiveVaultSets = (effective: EffectiveLabelsSource) => {
  const verified = new Set<string>()
  for (const product of Object.values(effective.products)) {
    for (const address of [...(product.vaults ?? []), ...(product.deprecatedVaults ?? [])]) {
      verified.add(address.toLowerCase())
    }
  }
  const earn = new Set(effective.earnVaults.map(entry =>
    (typeof entry === 'string' ? entry : entry.address).toLowerCase(),
  ))
  return { verified, earn }
}

const normalizeEffectiveEarnPolicy = (effective: EffectiveLabelsSource) => {
  const blocks: Record<string, string[]> = {}
  const restrictions: Record<string, string[]> = {}
  const notExplorable = new Set<string>()
  for (const raw of effective.earnVaults) {
    if (typeof raw === 'string') continue
    const address = tryAddress(raw.address)
    if (!address) continue
    const key = address.toLowerCase()
    if (raw.block?.length) blocks[key] = [...raw.block]
    if (raw.restricted?.length) restrictions[key] = [...raw.restricted]
    if (raw.notExplorable) notExplorable.add(key)
  }
  return { blocks, restrictions, notExplorable }
}

const normalizeEffectiveAssets = (entries: EulerLabelAssetEntry[]) => {
  const blocks: Record<string, string[]> = {}
  const restrictions: Record<string, string[]> = {}
  const patternRules: EulerLabelAssetPatternRule[] = []

  for (const entry of entries) {
    if (entry.address) {
      const address = tryAddress(entry.address)
      if (address) {
        const key = address.toLowerCase()
        if (entry.block?.length) blocks[key] = [...entry.block]
        if (entry.restricted?.length) restrictions[key] = [...entry.restricted]
      }
    }

    const rule: EulerLabelAssetPatternRule = {
      ...(entry.block?.length && { block: [...entry.block] }),
      ...(entry.restricted?.length && { restricted: [...entry.restricted] }),
    }
    if (!rule.block && !rule.restricted) continue
    if (entry.symbols?.length) rule.symbolsLower = new Set(entry.symbols.map(value => value.toLowerCase()))
    if (entry.names?.length) rule.namesLower = new Set(entry.names.map(value => value.toLowerCase()))
    if (entry.symbolRegex) rule.symbolRegex = new RegExp(entry.symbolRegex, 'i')
    if (entry.nameRegex) rule.nameRegex = new RegExp(entry.nameRegex, 'i')
    if (rule.symbolsLower || rule.symbolRegex || rule.namesLower || rule.nameRegex) {
      patternRules.push(rule)
    }
  }

  return { blocks, restrictions, patternRules }
}

/**
 * Adds Lite's temporary effective-policy compatibility layer to the canonical
 * Public Labels content normalized by the SDK.
 */
export const normalizePublicLabelsData = (
  chainId: number,
  source: PublicLabelsSource,
  effectivePolicy: EffectiveLabelsSource = emptyEffectiveLabelsSource(),
): PublicEulerLabelsData => {
  const data = normalizeSdkPublicLabelsData(chainId, source)
  const inventoryRows = source.vaults.filter(vault => vault.chainId === chainId)
  const { verified: compatibilityVerified, earn: compatibilityEarn } = getEffectiveVaultSets(effectivePolicy)

  // Plain-address labels and assessment-only rows have the same empty content
  // shape in the inventory. Retain an empty row only when the compatibility
  // snapshot already classifies that exact published inventory address.
  const compatibilityEarnRows = inventoryRows.filter(vault =>
    !hasPublishedVaultLabelContent(vault)
    && vault.vaultType === 'earn'
    && compatibilityEarn.has(vault.address.toLowerCase()),
  )
  const compatibilityVerifiedRows = inventoryRows.filter(vault =>
    !hasPublishedVaultLabelContent(vault)
    && vault.vaultType !== 'earn'
    && vault.vaultType !== 'escrow'
    && compatibilityVerified.has(vault.address.toLowerCase()),
  )

  const verifiedVaultAddresses = [
    ...data.verifiedVaultAddresses,
    ...compatibilityVerifiedRows.map(vault => getAddress(vault.address)),
  ]
  const earnVaults = [...data.earnVaults]
  const earnVaultEntries = { ...data.earnVaultEntries }
  for (const vault of compatibilityEarnRows) {
    const address = getAddress(vault.address)
    earnVaults.push(address)
    earnVaultEntries[address.toLowerCase()] ??= { address }
  }

  const products = data.products as Record<string, EulerLabelProduct>
  const effectiveEarn = normalizeEffectiveEarnPolicy(effectivePolicy)
  const effectiveAssets = normalizeEffectiveAssets(effectivePolicy.assets)

  // Apply the currently effective geo/visibility policy. Raw V3 geo policies
  // are intentionally not composed here: global/product/vault/asset precedence
  // and the final eligibility contract are not specified yet.
  for (const [productKey, product] of Object.entries(products)) {
    const effectiveProduct = effectivePolicy.products[productKey]
    if (!effectiveProduct) continue
    product.block = effectiveProduct.block
    product.restricted = effectiveProduct.restricted
    product.notExplorable = effectiveProduct.notExplorable
    const effectiveOverrides = new Map(
      Object.entries(effectiveProduct.vaultOverrides ?? {}).map(([address, override]) => [
        address.toLowerCase(),
        override,
      ]),
    )
    for (const address of [...product.vaults, ...(product.deprecatedVaults ?? [])]) {
      const target = product.vaultOverrides?.[address]
      const previous = effectiveOverrides.get(address.toLowerCase())
      if (!target || !previous) continue
      target.block = previous.block
      target.restricted = previous.restricted
      target.notExplorableLend = previous.notExplorableLend
      target.notExplorableBorrow = previous.notExplorableBorrow
    }
  }

  for (const [address, entry] of Object.entries(earnVaultEntries)) {
    entry.block = effectiveEarn.blocks[address]
    entry.restricted = effectiveEarn.restrictions[address]
    entry.notExplorable = effectiveEarn.notExplorable.has(address)
  }

  return {
    ...data,
    products,
    verifiedVaultAddresses: uniqueStrings(verifiedVaultAddresses),
    earnVaults: uniqueStrings(earnVaults),
    earnVaultEntries,
    earnVaultBlocks: effectiveEarn.blocks,
    earnVaultRestrictions: effectiveEarn.restrictions,
    notExplorableEarnVaults: effectiveEarn.notExplorable,
    assetBlocks: effectiveAssets.blocks,
    assetRestrictions: effectiveAssets.restrictions,
    assetPatternRules: effectiveAssets.patternRules,
  }
}
