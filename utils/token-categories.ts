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

const CORRELATED_CATEGORY_LABELS: Record<string, string> = {
  usd: 'USD',
  eth: 'ETH',
  btc: 'BTC',
}

const CORRELATED_CATEGORY_TAGS = new Set(Object.keys(CORRELATED_CATEGORY_LABELS))

const isCorrelatedCategory = (tag: string): boolean => CORRELATED_CATEGORY_TAGS.has(tag)

const correlatedCategories = (tags: TokenCategoryTagSource): string[] =>
  normalizeTokenCategoryTags(tags).filter(isCorrelatedCategory)

export const formatTokenCategoryLabel = (tag: string | null | undefined): string | undefined =>
  tag ? CORRELATED_CATEGORY_LABELS[tag.trim().toLowerCase()] : undefined

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
