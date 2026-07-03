import { getAddress } from 'viem'

export type TokenCategoryTagSource = readonly unknown[] | undefined | null

export const normalizeTokenCategoryTags = (
  tags: TokenCategoryTagSource,
): string[] => {
  if (!Array.isArray(tags)) return []

  const seen = new Set<string>()
  const normalized: string[] = []
  for (const tag of tags) {
    if (typeof tag !== 'string') continue
    const value = tag.trim().toLowerCase()
    if (!value || seen.has(value)) continue
    seen.add(value)
    normalized.push(value)
  }
  return normalized
}

export const CORRELATED_CATEGORY_LABELS: Record<string, string> = {
  usd: 'USD',
  eth: 'ETH',
  btc: 'BTC',
  mon: 'MON',
  avax: 'AVAX',
  hype: 'HYPE',
  bnb: 'BNB',
}

export const FILTER_CATEGORY_LABELS: Record<string, string> = {
  ...CORRELATED_CATEGORY_LABELS,
  pt: 'PT',
}

const CORRELATED_CATEGORY_TAGS = new Set(Object.keys(CORRELATED_CATEGORY_LABELS))
const FILTER_CATEGORY_TAGS = new Set(Object.keys(FILTER_CATEGORY_LABELS))
const TOKEN_CATEGORY_FILTER_PREFIX = 'category:'

const isCorrelatedCategory = (tag: string): boolean => CORRELATED_CATEGORY_TAGS.has(tag)
const isFilterCategory = (tag: string): boolean => FILTER_CATEGORY_TAGS.has(tag)

const correlatedCategories = (tags: TokenCategoryTagSource): string[] =>
  normalizeTokenCategoryTags(tags).filter(isCorrelatedCategory)

const filterCategories = (tags: TokenCategoryTagSource): string[] =>
  normalizeTokenCategoryTags(tags).filter(isFilterCategory)

export const formatTokenCategoryLabel = (tag: string | null | undefined): string | undefined =>
  tag ? CORRELATED_CATEGORY_LABELS[tag.trim().toLowerCase()] : undefined

export const getSupportedTokenCategoryOptions = (): { tag: string, label: string }[] =>
  Object.entries(FILTER_CATEGORY_LABELS).map(([tag, label]) => ({ tag, label }))

export const toTokenCategoryFilterValue = (tag: string): string =>
  `${TOKEN_CATEGORY_FILTER_PREFIX}${tag.trim().toLowerCase()}`

export const fromTokenCategoryFilterValue = (value: string): string | null => {
  if (!value.startsWith(TOKEN_CATEGORY_FILTER_PREFIX)) return null

  const tag = value.slice(TOKEN_CATEGORY_FILTER_PREFIX.length).trim().toLowerCase()
  return isFilterCategory(tag) ? tag : null
}

export const isTokenCategoryFilterValue = (value: string): boolean =>
  fromTokenCategoryFilterValue(value) !== null

export const tokenAddressMatchesCategoryFilter = (
  address: string | undefined | null,
  categoryFilterValue: string,
  getTokenCategoryTags: (address: string) => TokenCategoryTagSource,
): boolean => {
  const category = fromTokenCategoryFilterValue(categoryFilterValue)
  const normalized = normalizeComparableAddress(address)
  if (!category || !normalized) return false

  return filterCategories(getTokenCategoryTags(normalized)).includes(category)
}

export const shareTokenCategory = (
  leftTags: TokenCategoryTagSource,
  rightTags: TokenCategoryTagSource,
): boolean => {
  return getSharedTokenCategory([leftTags, rightTags]) !== null
}

export const getSharedTokenCategory = (
  tagSources: readonly TokenCategoryTagSource[],
): string | null => {
  if (tagSources.length < 2) return null

  let common: Set<string> | null = null

  for (const tags of tagSources) {
    const correlated = correlatedCategories(tags)
    if (!correlated.length) return null

    if (common === null) {
      common = new Set(correlated)
      continue
    }

    common = new Set(correlated.filter(tag => common!.has(tag)))
    if (!common.size) return null
  }

  return common?.values().next().value ?? null
}

export const shareCommonTokenCategory = (
  tagSources: readonly TokenCategoryTagSource[],
): boolean => getSharedTokenCategory(tagSources) !== null

const normalizeComparableAddress = (
  address: string | undefined | null,
): string => {
  if (!address) return ''
  try {
    return getAddress(address).toLowerCase()
  }
  catch {
    return address.toLowerCase()
  }
}

export const areTokenAddressesCorrelatedByTags = (
  leftAddress: string | undefined | null,
  rightAddress: string | undefined | null,
  getTokenCategoryTags: (address: string) => TokenCategoryTagSource,
): boolean => {
  const left = normalizeComparableAddress(leftAddress)
  const right = normalizeComparableAddress(rightAddress)
  if (!left || !right) return false
  if (left === right) return true

  return shareTokenCategory(
    getTokenCategoryTags(left),
    getTokenCategoryTags(right),
  )
}

export const areTokenAddressesInSameCorrelatedCategory = (
  addresses: readonly (string | undefined | null)[],
  getTokenCategoryTags: (address: string) => TokenCategoryTagSource,
): boolean => {
  const normalized = addresses.map(normalizeComparableAddress)
  if (normalized.some(address => !address)) return false
  if (normalized.length < 2) return false
  if (normalized.every(address => address === normalized[0])) return true

  return shareCommonTokenCategory(normalized.map(address => getTokenCategoryTags(address)))
}

export const getTokenAddressesCorrelationCategoryLabel = (
  addresses: readonly (string | undefined | null)[],
  getTokenCategoryTags: (address: string) => TokenCategoryTagSource,
): string | undefined => {
  const normalized = addresses.map(normalizeComparableAddress)
  if (normalized.some(address => !address)) return undefined
  if (normalized.length < 2) return undefined

  return formatTokenCategoryLabel(
    getSharedTokenCategory(normalized.map(address => getTokenCategoryTags(address))),
  )
}
