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
import { getCurrentEulerLabelsData, getEulerLabelWrapPairs } from '~/composables/useEulerLabels'
import { normalizeAddress } from '~/utils/normalizeAddress'

const labels = () => getCurrentEulerLabelsData()

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

export const getProductByVault = (vaultAddress: string): EulerLabelProduct =>
  (getEulerLabelProductByVault(labels(), vaultAddress) as EulerLabelProduct | undefined)
  || eulerLabelProductEmpty

export const getProductKeyByVault = (vaultAddress: string): string | undefined =>
  getEulerLabelProductKeyByVault(labels(), vaultAddress)

export const getActiveProductVaultAddresses = (): string[] =>
  Object.values(labels().products).flatMap(product => product.vaults)

export const getVaultBlock = (vaultAddress: string): string[] | undefined =>
  getEulerLabelVaultBlock(labels(), vaultAddress)

export const getEarnVaultBlock = (vaultAddress: string): string[] | undefined =>
  getEulerLabelEarnVaultBlock(labels(), vaultAddress)

export const getVaultRestricted = (vaultAddress: string): string[] | undefined =>
  getEulerLabelVaultRestricted(labels(), vaultAddress)

export const getEarnVaultRestricted = (vaultAddress: string): string[] | undefined =>
  getEulerLabelEarnVaultRestricted(labels(), vaultAddress)

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

export const isVaultRecentlyAdded = (vaultAddress: string): boolean => {
  const normalized = normalizeAddress(vaultAddress)
  const product = getEulerLabelProductByVault(labels(), normalized) as EulerLabelProduct | undefined
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

export const isEarnVaultDeprecated = (vaultAddress: string): boolean =>
  isEulerLabelEarnVaultDeprecated(labels(), vaultAddress)

export const isEarnVaultNotExplorable = (vaultAddress: string): boolean =>
  isEulerLabelEarnVaultNotExplorable(labels(), vaultAddress)

export const getEarnVaultDeprecationReason = (vaultAddress: string): string =>
  getEulerLabelEarnVaultDeprecationReason(labels(), vaultAddress)

export const getEarnVaultDescription = (vaultAddress: string): string =>
  getEulerLabelEarnVaultDescription(labels(), vaultAddress)

export const getEarnVaultNotice = (vaultAddress: string): string =>
  getEulerLabelEarnVaultNotice(labels(), vaultAddress)

export const getVaultNotice = (vaultAddress: string): string =>
  getEulerLabelVaultNotice(labels(), vaultAddress)

export const isVaultNoticeSpecific = (vaultAddress: string): boolean =>
  isEulerLabelVaultNoticeSpecific(labels(), vaultAddress)

export const isVaultDeprecated = (vaultAddress: string): boolean =>
  isEulerLabelVaultDeprecated(labels(), vaultAddress)

export const isVaultNotExplorable = (vaultAddress: string): boolean =>
  isEulerLabelVaultNotExplorable(labels(), vaultAddress)

export const isVaultNotExplorableLend = (vaultAddress: string): boolean =>
  isEulerLabelVaultNotExplorableLend(labels(), vaultAddress)

export const isVaultNotExplorableBorrow = (vaultAddress: string): boolean =>
  isEulerLabelVaultNotExplorableBorrow(labels(), vaultAddress)

export const isVaultKeyring = (vaultAddress: string): boolean =>
  isEulerLabelVaultKeyring(labels(), vaultAddress)

export const isProductKeyring = (productKey: string): boolean =>
  isEulerLabelProductKeyring(labels(), productKey)

export const isVaultAccessControlled = (vaultAddress: string): boolean =>
  isEulerLabelVaultAccessControlled(labels(), vaultAddress)

export const isVaultGovernanceLimited = (vaultAddress: string): boolean => {
  const normalized = normalizeAddress(vaultAddress)
  const product = getEulerLabelProductByVault(labels(), normalized) as EulerLabelProduct | undefined
  return productHasTag(product, 'governance limited')
}

export const isVaultHighUtilisationWarningSuppressed = (vaultAddress: string): boolean => {
  const normalized = normalizeAddress(vaultAddress)
  const product = getEulerLabelProductByVault(labels(), normalized) as EulerLabelProduct | undefined
  return (
    productHasTag(product, 'suppress high utilisation warning')
    || vaultOverrideHasTag(product, normalized, 'suppress high utilisation warning')
  )
}

export type EulerLabelEntityVaultLike = {
  address?: string
  governorAdmin?: string
  governor?: string
}

export const getEntitiesByVault = (vault: EulerLabelEntityVaultLike): EulerLabelEntity[] =>
  getEulerLabelEntitiesByVault(labels(), vault) as EulerLabelEntity[]

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
  getEulerLabelEntitiesByEarnVault(labels(), earnVault) as EulerLabelEntity[]

export const getPointsByVault = (vaultAddress: string): EulerLabelPointReward[] =>
  getEulerLabelPointsByVault(labels(), vaultAddress) as EulerLabelPointReward[]

export const applyVaultOverrides = (product: EulerLabelProduct, vaultAddress: string): EulerLabelProduct =>
  applyEulerLabelVaultOverrides(product, vaultAddress) as EulerLabelProduct

export const getVaultProductName = (vaultAddress: string): string =>
  getEulerLabelVaultProductName(labels(), vaultAddress)
