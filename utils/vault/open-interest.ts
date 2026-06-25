import { getAddress } from 'viem'
import { formatCompactUsdValue } from '~/utils/string-utils'

export interface OpenInterestCollateralInput {
  address: string
  label: string
  valueUsd: number
}

export interface OpenInterestNode {
  id: string
  label: string
  valueUsd: number
  percentage: number
  displayValue: string
}

export interface OpenInterestFlow {
  id: string
  source: OpenInterestNode
  targetId: 'borrowed'
  valueUsd: number
  width: number
}

export interface OpenInterestModel {
  collateralNodes: OpenInterestNode[]
  rightNodes: {
    cash: OpenInterestNode
    borrowed: OpenInterestNode
  }
  flows: OpenInterestFlow[]
  totalUsd: number
}

export interface OpenInterestCollateralMapResponse {
  data?: Record<string, Record<string, number>>
  meta?: {
    refreshedAt?: string | null
    calculationTimestamp?: string | null
    priceTimestamp?: string | null
    ageSeconds?: number | null
  }
}

export interface OpenInterestResponse {
  data?: Array<{
    vault: string
    asset: string
    totalBorrows: string
    borrowerCount: number
    timestamp: string
  }>
}

const MAX_FLOW_WIDTH = 18
const MIN_FLOW_WIDTH = 2.5

export const normalizeOpenInterestAddress = (address: string): string => {
  try {
    return getAddress(address).toLowerCase()
  }
  catch {
    return address.toLowerCase()
  }
}

export const findOpenInterestMapForVault = (
  data: Record<string, Record<string, number>> | undefined,
  vaultAddress: string,
): Record<string, number> => {
  if (!data) return {}
  const normalizedVault = normalizeOpenInterestAddress(vaultAddress)
  const entry = Object.entries(data).find(([address]) => normalizeOpenInterestAddress(address) === normalizedVault)
  return entry?.[1] ?? {}
}

const toNode = (
  id: string,
  label: string,
  valueUsd: number,
  totalUsd: number,
): OpenInterestNode => ({
  id,
  label,
  valueUsd,
  percentage: totalUsd > 0 ? valueUsd / totalUsd * 100 : 0,
  displayValue: formatCompactUsdValue(valueUsd),
})

export const summarizeCollateralOpenInterest = (
  collaterals: OpenInterestCollateralInput[],
  maxNodes = 6,
): OpenInterestCollateralInput[] => {
  const sorted = collaterals
    .filter(item => Number.isFinite(item.valueUsd) && item.valueUsd > 0)
    .sort((a, b) => b.valueUsd - a.valueUsd)

  if (sorted.length <= maxNodes) return sorted

  const visibleCount = Math.max(1, maxNodes - 1)
  const visible = sorted.slice(0, visibleCount)
  const otherValueUsd = sorted.slice(visibleCount).reduce((sum, item) => sum + item.valueUsd, 0)

  return [
    ...visible,
    {
      address: 'other',
      label: 'Other',
      valueUsd: otherValueUsd,
    },
  ]
}

export const buildOpenInterestModel = ({
  collaterals,
  cashUsd,
  borrowedUsd,
  maxCollateralNodes = 6,
}: {
  collaterals: OpenInterestCollateralInput[]
  cashUsd: number
  borrowedUsd: number
  maxCollateralNodes?: number
}): OpenInterestModel => {
  const summarizedCollaterals = summarizeCollateralOpenInterest(collaterals, maxCollateralNodes)
  const collateralTotalUsd = summarizedCollaterals.reduce((sum, item) => sum + item.valueUsd, 0)
  const rightTotalUsd = Math.max(0, cashUsd) + Math.max(0, borrowedUsd)
  const totalUsd = Math.max(collateralTotalUsd, rightTotalUsd)

  const collateralNodes = summarizedCollaterals.map(item =>
    toNode(item.address, item.label, item.valueUsd, collateralTotalUsd),
  )
  const cash = toNode('cash', 'Available liquidity', Math.max(0, cashUsd), rightTotalUsd)
  const borrowed = toNode('borrowed', 'Outstanding borrows', Math.max(0, borrowedUsd), rightTotalUsd)
  const largestFlowUsd = Math.max(...collateralNodes.map(node => node.valueUsd), borrowed.valueUsd, 1)

  return {
    collateralNodes,
    rightNodes: {
      cash,
      borrowed,
    },
    flows: collateralNodes.map(node => ({
      id: `${node.id}-borrowed`,
      source: node,
      targetId: 'borrowed',
      valueUsd: node.valueUsd,
      width: Math.max(MIN_FLOW_WIDTH, node.valueUsd / largestFlowUsd * MAX_FLOW_WIDTH),
    })),
    totalUsd,
  }
}
