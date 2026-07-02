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
  calculationTimestamp: string
  priceTimestamp: string | null
  refreshedAt: string
}

export interface V3VaultBadDebtResponse {
  data?: V3VaultBadDebtRow[]
}

export interface VaultBadDebtCacheEntry {
  badDebtUsd: number
  debtUsd: number
  collateralUsd: number
  coveredDebtUsd: number
  accountCount: number
  calculationTimestamp: string
  priceTimestamp: string | null
  refreshedAt: string
}

const normalizeAddress = (address: string) => address.toLowerCase()

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
  return parts.join(' - ')
}
