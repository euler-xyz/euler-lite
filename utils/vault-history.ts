import { formatUnits, maxUint256 } from 'viem'
import { V3_API_PROXY_URL } from '~/utils/api-url-env'

export const VAULT_HISTORY_TIMEFRAMES = [
  { value: '7d', label: '7D', days: 7 },
  { value: '30d', label: '30D', days: 30 },
  { value: '90d', label: '90D', days: 90 },
] as const

export type VaultHistoryTimeframe = typeof VAULT_HISTORY_TIMEFRAMES[number]['value']
export const VAULT_HISTORY_FETCH_TIMEFRAME: VaultHistoryTimeframe = '90d'
export type VaultHistoryMetric
  = | 'apy'
    | 'totalSupply'
    | 'totalBorrows'
    | 'utilization'
    | 'cash'
export type VaultHistoryPoint = {
  timestamp: string
  totalAssets: number | null
  totalAssetsUsd: number | null
  totalBorrows: number | null
  totalBorrowsUsd: number | null
  cash: number | null
  cashUsd: number | null
  utilization: number | null
  supplyApy: number | null
  borrowApy: number | null
  sharePrice: number | null
}

type RawVaultHistoryPoint = {
  timestamp?: unknown
  totalAssets?: unknown
  totalAssetsUsd?: unknown
  totalSupplyUsd?: unknown
  totalBorrows?: unknown
  totalBorrowsUsd?: unknown
  cash?: unknown
  cashUsd?: unknown
  utilization?: unknown
  supplyApy?: unknown
  borrowApy?: unknown
  apy?: unknown
  sharePrice?: unknown
}

export type VaultTotalsHistoryResponse = {
  data?: {
    history?: RawVaultHistoryPoint[]
  }
}

const SECOND = 1_000
const DAY_SECONDS = 24 * 60 * 60

const parseAmount = (value: unknown, decimals: number): number | null => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) return null
  try {
    const parsed = Number(formatUnits(BigInt(value), decimals))
    return Number.isFinite(parsed) ? parsed : null
  }
  catch {
    return null
  }
}

const parseNumber = (value: unknown): number | null => {
  if (value == null) return null
  const parsed = typeof value === 'number' ? value : Number(value)
  return Number.isFinite(parsed) ? parsed : null
}

export const parseVaultTotalsHistory = (
  response: VaultTotalsHistoryResponse,
  decimals: number,
): VaultHistoryPoint[] => {
  const history = response.data?.history
  if (!Array.isArray(history)) return []

  return history
    .map((point): VaultHistoryPoint | null => {
      if (typeof point.timestamp !== 'string') return null
      return {
        timestamp: point.timestamp,
        totalAssets: parseAmount(point.totalAssets, decimals),
        totalAssetsUsd: parseNumber(point.totalAssetsUsd ?? point.totalSupplyUsd),
        totalBorrows: parseAmount(point.totalBorrows, decimals),
        totalBorrowsUsd: parseNumber(point.totalBorrowsUsd),
        cash: parseAmount(point.cash, decimals),
        cashUsd: parseNumber(point.cashUsd),
        utilization: parseNumber(point.utilization),
        supplyApy: parseNumber(point.supplyApy ?? point.apy),
        borrowApy: parseNumber(point.borrowApy),
        sharePrice: parseNumber(point.sharePrice),
      }
    })
    .filter((point): point is VaultHistoryPoint => point !== null)
}

export const getVaultHistoryTimeRange = (
  timeframe: VaultHistoryTimeframe,
  nowMs = Date.now(),
): { from: number, to: number } => {
  const option = VAULT_HISTORY_TIMEFRAMES.find(item => item.value === timeframe) ?? VAULT_HISTORY_TIMEFRAMES[1]
  const nowSeconds = Math.floor(nowMs / SECOND)
  const to = Math.floor(nowSeconds / DAY_SECONDS) * DAY_SECONDS
  const from = to - option.days * DAY_SECONDS

  return { from, to }
}

export const buildVaultTotalsHistoryPath = (
  chainId: string | number,
  address: string,
  timeframe: VaultHistoryTimeframe,
  nowMs = Date.now(),
): string => {
  const { from, to } = getVaultHistoryTimeRange(timeframe, nowMs)
  const params = new URLSearchParams({
    resolution: '1d',
    from: String(from),
    to: String(to),
  })

  return `${V3_API_PROXY_URL}/evk/vaults/${encodeURIComponent(String(chainId))}/${encodeURIComponent(address)}/totals?${params.toString()}`
}

export const hasFiniteCap = (cap: bigint | null | undefined): cap is bigint =>
  typeof cap === 'bigint' && cap > 0n && cap < maxUint256
