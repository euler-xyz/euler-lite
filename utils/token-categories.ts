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

const CORRELATED_CATEGORY_TAGS = new Set(['usd', 'eth', 'btc'])

const isCorrelatedCategory = (tag: string): boolean => CORRELATED_CATEGORY_TAGS.has(tag)

export const shareTokenCategory = (
  leftTags: TokenCategoryTagSource,
  rightTags: TokenCategoryTagSource,
): boolean => {
  const left = normalizeTokenCategoryTags(leftTags).filter(isCorrelatedCategory)
  if (!left.length) return false

  const right = new Set(normalizeTokenCategoryTags(rightTags).filter(isCorrelatedCategory))
  if (!right.size) return false

  return left.some(tag => right.has(tag))
}

export const shareCommonTokenCategory = (
  tagSources: readonly TokenCategoryTagSource[],
): boolean => {
  if (tagSources.length < 2) return false

  let common: Set<string> | null = null

  for (const tags of tagSources) {
    const correlated = normalizeTokenCategoryTags(tags).filter(isCorrelatedCategory)
    if (!correlated.length) return false

    if (common === null) {
      common = new Set(correlated)
      continue
    }

    common = new Set(correlated.filter(tag => common!.has(tag)))
    if (!common.size) return false
  }

  return (common?.size ?? 0) > 0
}

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
