import { formatCompactUsdValue, formatNumber } from '~/utils/string-utils'

export interface V3VaultBadDebtRow {
  chainId: number
  borrowVault: string
  borrowAsset: string
  accountCount: number
  debtUsd: number
  collateralUsd: number
  coveredDebtUsd: number
  badDebtUsd: number
  unpricedBadDebtUsd?: number | null
  unpricedCollateralCount?: number | null
  calculationTimestamp: string
  priceTimestamp: string | null
  refreshedAt: string
}

export interface V3VaultBadDebtResponse {
  data?: V3VaultBadDebtRow[]
}

export type VaultBadDebtPricing
  = | { status: 'reported', unpricedUsd: number, unpricedCollateralCount: number }
    | { status: 'not-reported' }
    | { status: 'invalid' }

export interface VaultBadDebtCacheEntry {
  badDebtUsd: number
  debtUsd: number
  collateralUsd: number
  coveredDebtUsd: number
  accountCount: number
  pricing: VaultBadDebtPricing
  calculationTimestamp: string
  priceTimestamp: string | null
  refreshedAt: string
}

const UNPRICED_BAD_DEBT_RELATIVE_TOLERANCE = 1e-9
const UNPRICED_BAD_DEBT_ABSOLUTE_TOLERANCE_USD = 1e-6

const normalizeAddress = (address: string) => address.toLowerCase()

const readBadDebtPricing = (row: V3VaultBadDebtRow): VaultBadDebtPricing => {
  const { unpricedBadDebtUsd: unpricedUsd, unpricedCollateralCount: count } = row
  if (unpricedUsd == null || count == null) return { status: 'not-reported' }
  const validUsd = typeof unpricedUsd === 'number'
    && Number.isFinite(unpricedUsd)
    && unpricedUsd >= 0
    && unpricedUsd <= row.badDebtUsd * (1 + UNPRICED_BAD_DEBT_RELATIVE_TOLERANCE) + UNPRICED_BAD_DEBT_ABSOLUTE_TOLERANCE_USD
  const validCount = Number.isSafeInteger(count) && count >= 0
  const consistent = (unpricedUsd > 0) === (count > 0)
  return validUsd && validCount && consistent
    ? { status: 'reported', unpricedUsd, unpricedCollateralCount: count }
    : { status: 'invalid' }
}

const formatBadDebtPricing = (pricing: VaultBadDebtPricing): string => {
  if (pricing.status === 'not-reported') return 'no data on unpriced collateral'
  if (pricing.status === 'invalid') return 'unpriced collateral data is invalid'
  if (pricing.unpricedCollateralCount === 0) return 'all collateral priced'
  const positions = pricing.unpricedCollateralCount === 1 ? 'position' : 'positions'
  return `${formatCompactUsdValue(pricing.unpricedUsd)} of the bad debt is from ${pricing.unpricedCollateralCount} collateral ${positions} with no price (valued at $0)`
}

export const buildBadDebtCache = (
  rows: readonly V3VaultBadDebtRow[],
): Map<string, VaultBadDebtCacheEntry> => {
  const result = new Map<string, VaultBadDebtCacheEntry>()
  for (const row of rows) {
    if (!row.borrowVault || !Number.isFinite(row.badDebtUsd)) continue
    result.set(normalizeAddress(row.borrowVault), {
      badDebtUsd: row.badDebtUsd,
      debtUsd: row.debtUsd,
      collateralUsd: row.collateralUsd,
      coveredDebtUsd: row.coveredDebtUsd,
      accountCount: row.accountCount,
      pricing: readBadDebtPricing(row),
      calculationTimestamp: row.calculationTimestamp,
      priceTimestamp: row.priceTimestamp,
      refreshedAt: row.refreshedAt,
    })
  }
  return result
}

export const parseBadDebtResponse = (body: unknown): V3VaultBadDebtRow[] => {
  if (!body || typeof body !== 'object') return []
  const response = body as V3VaultBadDebtResponse
  return Array.isArray(response.data) ? response.data : []
}

export const getBadDebtBorrowRatio = (
  badDebt: VaultBadDebtCacheEntry,
  totalBorrowUsd: number | undefined,
): number | undefined => {
  if (totalBorrowUsd === undefined || totalBorrowUsd <= 0) return undefined
  return (badDebt.badDebtUsd / totalBorrowUsd) * 100
}

export const formatBadDebtUsd = (badDebt: VaultBadDebtCacheEntry): string =>
  formatCompactUsdValue(badDebt.badDebtUsd)

export const formatBadDebtOverviewValue = (
  badDebt: VaultBadDebtCacheEntry,
  totalBorrowUsd: number | undefined,
): string => {
  const ratio = getBadDebtBorrowRatio(badDebt, totalBorrowUsd)
  const value = formatBadDebtUsd(badDebt)
  return ratio === undefined ? value : `${value} (${formatNumber(ratio, 2, 0)}%)`
}

export const formatBadDebtHint = (
  badDebt: VaultBadDebtCacheEntry,
  totalBorrowUsd: number | undefined,
): string => {
  const parts = [`${formatCompactUsdValue(badDebt.badDebtUsd)} bad debt`]
  const ratio = getBadDebtBorrowRatio(badDebt, totalBorrowUsd)
  if (ratio !== undefined) parts.push(`${formatNumber(ratio, 2, 0)}% of total borrows`)
  if (badDebt.accountCount > 0) {
    parts.push(`${badDebt.accountCount} underwater ${badDebt.accountCount === 1 ? 'account' : 'accounts'}`)
  }
  parts.push(formatBadDebtPricing(badDebt.pricing))
  return parts.join(' - ')
}
