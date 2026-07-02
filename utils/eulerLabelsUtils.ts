import {
  applyEulerLabelVaultOverrides,
  getEulerLabelAssetBlock,
  getEulerLabelAssetRestricted,
  getEulerLabelEarnVaultBlock,
  getEulerLabelEarnVaultDeprecationReason,
  getEulerLabelEarnVaultDescription,
  getEulerLabelEarnVaultNotice,
  getEulerLabelEarnVaultRestricted,
  getEulerLabelEntitiesByEarnVault,
  getEulerLabelEntitiesByVault,
  getEulerLabelPointsByVault,
  getEulerLabelProductByVault,
  getEulerLabelProductKeyByVault,
  getEulerLabelVaultBlock,
  getEulerLabelVaultNotice,
  getEulerLabelVaultProductName,
  getEulerLabelVaultRestricted,
  isEulerLabelEarnVaultDeprecated,
  isEulerLabelEarnVaultNotExplorable,
  isEulerLabelProductKeyring,
  isEulerLabelVaultDeprecated,
  isEulerLabelVaultAccessControlled,
  isEulerLabelVaultKeyring,
  isEulerLabelVaultNotExplorable,
  isEulerLabelVaultNotExplorableBorrow,
  isEulerLabelVaultNotExplorableLend,
  isEulerLabelVaultNoticeSpecific,
  type EulerLabelAssetPatternRule,
  type EulerEarn,
} from '@eulerxyz/euler-v2-sdk'
import { eulerLabelProductEmpty, type EulerLabelEarnVaultEntry, type EulerLabelProduct, type EulerLabelEntity, type EulerLabelPointReward } from '~/entities/euler/labels'
import { getCurrentEulerLabelsData, getEulerLabelWrapPairs, getEulerLabelsDataForChain } from '~/composables/useEulerLabels'
import { normalizeAddress } from '~/utils/normalizeAddress'

const labels = (chainId?: number) => chainId ? getEulerLabelsDataForChain(chainId) : getCurrentEulerLabelsData()

const MAX_REGEX_INPUT_LEN = 128

export const patternRuleMatches = (
  rule: EulerLabelAssetPatternRule,
  symbolLower: string | undefined,
  nameLower: string | undefined,
): boolean => {
  if (rule.symbolsLower && symbolLower && rule.symbolsLower.has(symbolLower)) return true
  if (rule.symbolRegex && symbolLower) {
    if (symbolLower.length > MAX_REGEX_INPUT_LEN) return true
    if (rule.symbolRegex.test(symbolLower)) return true
  }
  if (rule.namesLower && nameLower && rule.namesLower.has(nameLower)) return true
  if (rule.nameRegex && nameLower) {
    if (nameLower.length > MAX_REGEX_INPUT_LEN) return true
    if (rule.nameRegex.test(nameLower)) return true
  }
  return false
}

export const isWrapPair = (a: string | undefined, b: string | undefined): boolean => {
  if (!a || !b) return false
  const pairs = getEulerLabelWrapPairs()
  const al = a.toLowerCase()
  const bl = b.toLowerCase()
  return pairs[al] === bl || pairs[bl] === al
}

export const getProductByVault = (vaultAddress: string, chainId?: number): EulerLabelProduct =>
  (getEulerLabelProductByVault(labels(chainId), vaultAddress) as EulerLabelProduct | undefined)
  || eulerLabelProductEmpty

export const getProductKeyByVault = (vaultAddress: string, chainId?: number): string | undefined =>
  getEulerLabelProductKeyByVault(labels(chainId), vaultAddress)

export const getActiveProductVaultAddresses = (): string[] =>
  Object.values(labels().products).flatMap(product => product.vaults)

export const getVaultBlock = (vaultAddress: string, chainId?: number): string[] | undefined =>
  getEulerLabelVaultBlock(labels(chainId), vaultAddress)

export const getEarnVaultBlock = (vaultAddress: string, chainId?: number): string[] | undefined =>
  getEulerLabelEarnVaultBlock(labels(chainId), vaultAddress)

export const getVaultRestricted = (vaultAddress: string, chainId?: number): string[] | undefined =>
  getEulerLabelVaultRestricted(labels(chainId), vaultAddress)

export const getEarnVaultRestricted = (vaultAddress: string, chainId?: number): string[] | undefined =>
  getEulerLabelEarnVaultRestricted(labels(chainId), vaultAddress)

export const getAssetBlock = (assetAddress: string): string[] | undefined =>
  getEulerLabelAssetBlock(labels(), assetAddress)

export const getAssetRestricted = (assetAddress: string): string[] | undefined =>
  getEulerLabelAssetRestricted(labels(), assetAddress)

export const getAssetPatternRules = (): EulerLabelAssetPatternRule[] =>
  labels().assetPatternRules

const productHasTag = (product: EulerLabelProduct | undefined, tag: string): boolean =>
  product?.tags?.includes(tag) ?? false

const vaultOverrideHasTag = (
  product: EulerLabelProduct | undefined,
  normalizedVaultAddress: string,
  tag: string,
): boolean =>
  product?.vaultOverrides?.[normalizedVaultAddress]?.tags?.includes(tag) ?? false

const earnEntryHasTag = (entry: EulerLabelEarnVaultEntry | undefined, tag: string): boolean =>
  entry?.tags?.includes(tag) ?? false

const getEarnEntryByVault = (normalizedVaultAddress: string): EulerLabelEarnVaultEntry | undefined =>
  labels().earnVaultEntries[normalizedVaultAddress.toLowerCase()] as EulerLabelEarnVaultEntry | undefined

export const isVaultRecentlyAdded = (vaultAddress: string, chainId?: number): boolean => {
  const normalized = normalizeAddress(vaultAddress)
  const product = getEulerLabelProductByVault(labels(chainId), normalized) as EulerLabelProduct | undefined
  return (
    productHasTag(product, 'recently added')
    || vaultOverrideHasTag(product, normalized, 'recently added')
    || earnEntryHasTag(getEarnEntryByVault(normalized), 'recently added')
  )
}

export const normalizeProducts = (data: Record<string, EulerLabelProduct>): { products: Record<string, EulerLabelProduct>, vaultAddresses: string[] } => {
  const normalized: Record<string, EulerLabelProduct> = {}
  const allVaults = new Set<string>()

  Object.entries(data).forEach(([key, product]) => {
    const normalizedVaults = product.vaults.map(normalizeAddress)
    const normalizedDeprecated = (product.deprecatedVaults || []).map(normalizeAddress)
    const fallbackReason = (product as EulerLabelProduct & { deprecateReason?: string }).deprecateReason

    normalized[key] = {
      ...product,
      vaults: normalizedVaults,
      deprecatedVaults: normalizedDeprecated,
      deprecationReason: product.deprecationReason || fallbackReason,
    }

    normalizedVaults.forEach(v => allVaults.add(v))
    normalizedDeprecated.forEach(v => allVaults.add(v))
  })

  return { products: normalized, vaultAddresses: [...allVaults] }
}

export const isEarnVaultDeprecated = (vaultAddress: string, chainId?: number): boolean =>
  isEulerLabelEarnVaultDeprecated(labels(chainId), vaultAddress)

export const isEarnVaultNotExplorable = (vaultAddress: string, chainId?: number): boolean =>
  isEulerLabelEarnVaultNotExplorable(labels(chainId), vaultAddress)

export const getEarnVaultDeprecationReason = (vaultAddress: string, chainId?: number): string =>
  getEulerLabelEarnVaultDeprecationReason(labels(chainId), vaultAddress)

export const getEarnVaultDescription = (vaultAddress: string, chainId?: number): string =>
  getEulerLabelEarnVaultDescription(labels(chainId), vaultAddress)

export const getEarnVaultNotice = (vaultAddress: string, chainId?: number): string =>
  getEulerLabelEarnVaultNotice(labels(chainId), vaultAddress)

export const getVaultNotice = (vaultAddress: string, chainId?: number): string =>
  getEulerLabelVaultNotice(labels(chainId), vaultAddress)

export const isVaultNoticeSpecific = (vaultAddress: string, chainId?: number): boolean =>
  isEulerLabelVaultNoticeSpecific(labels(chainId), vaultAddress)

export const isVaultDeprecated = (vaultAddress: string, chainId?: number): boolean =>
  isEulerLabelVaultDeprecated(labels(chainId), vaultAddress)

export const isVaultNotExplorable = (vaultAddress: string, chainId?: number): boolean =>
  isEulerLabelVaultNotExplorable(labels(chainId), vaultAddress)

export const isVaultNotExplorableLend = (vaultAddress: string, chainId?: number): boolean =>
  isEulerLabelVaultNotExplorableLend(labels(chainId), vaultAddress)

export const isVaultNotExplorableBorrow = (vaultAddress: string, chainId?: number): boolean =>
  isEulerLabelVaultNotExplorableBorrow(labels(chainId), vaultAddress)

export const isVaultKeyring = (vaultAddress: string, chainId?: number): boolean =>
  isEulerLabelVaultKeyring(labels(chainId), vaultAddress)

export const isProductKeyring = (productKey: string): boolean =>
  isEulerLabelProductKeyring(labels(), productKey)

export const isVaultAccessControlled = (vaultAddress: string, chainId?: number): boolean =>
  isEulerLabelVaultAccessControlled(labels(chainId), vaultAddress)

export const isVaultGovernanceLimited = (vaultAddress: string, chainId?: number): boolean => {
  const normalized = normalizeAddress(vaultAddress)
  const product = getEulerLabelProductByVault(labels(chainId), normalized) as EulerLabelProduct | undefined
  return (
    productHasTag(product, 'governance limited')
    || vaultOverrideHasTag(product, normalized, 'governance limited')
  )
}

export const isVaultHighUtilisationWarningSuppressed = (vaultAddress: string, chainId?: number): boolean => {
  const normalized = normalizeAddress(vaultAddress)
  const product = getEulerLabelProductByVault(labels(chainId), normalized) as EulerLabelProduct | undefined
  return (
    productHasTag(product, 'suppress high utilisation warning')
    || vaultOverrideHasTag(product, normalized, 'suppress high utilisation warning')
  )
}

export const isVaultCyclicalNote = (vaultAddress: string, chainId?: number): boolean => {
  const normalized = normalizeAddress(vaultAddress)
  const product = getEulerLabelProductByVault(labels(chainId), normalized) as EulerLabelProduct | undefined
  return (
    productHasTag(product, 'cyclical note')
    || vaultOverrideHasTag(product, normalized, 'cyclical note')
  )
}

export type EulerLabelEntityVaultLike = {
  address?: string
  chainId?: number
  governorAdmin?: string
  governor?: string
}

export const getEntitiesByVault = (vault: EulerLabelEntityVaultLike): EulerLabelEntity[] =>
  getEulerLabelEntitiesByVault(labels(vault.chainId), vault) as EulerLabelEntity[]

export const getUniqueEntitiesByVaults = (vaults: EulerLabelEntityVaultLike[]): EulerLabelEntity[] => {
  const seen = new Set<string>()
  const entities: EulerLabelEntity[] = []

  for (const vault of vaults) {
    for (const entity of getEntitiesByVault(vault)) {
      if (seen.has(entity.name)) continue
      seen.add(entity.name)
      entities.push(entity)
    }
  }

  return entities
}

export const getEntitiesByEarnVault = (earnVault: EulerEarn): EulerLabelEntity[] =>
  getEulerLabelEntitiesByEarnVault(labels(earnVault.chainId), earnVault) as EulerLabelEntity[]

export const getPointsByVault = (vaultAddress: string, chainId?: number): EulerLabelPointReward[] =>
  getEulerLabelPointsByVault(labels(chainId), vaultAddress) as EulerLabelPointReward[]

export const applyVaultOverrides = (product: EulerLabelProduct, vaultAddress: string): EulerLabelProduct =>
  applyEulerLabelVaultOverrides(product, vaultAddress) as EulerLabelProduct

export const getVaultProductName = (vaultAddress: string, chainId?: number): string =>
  getEulerLabelVaultProductName(labels(chainId), vaultAddress)
