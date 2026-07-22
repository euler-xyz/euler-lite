import type { EVault } from '@eulerxyz/euler-v2-sdk'
import type { ProjectedRates, ProjectedRatesRequest } from '~/utils/vault/apy'

export interface LendSwapProjectionPlan {
  requests: ProjectedRatesRequest[]
  sourceIndex: number | null
  targetIndex: number
}

export const buildLendSwapProjectionPlan = (
  sourceVault: EVault | null,
  targetVault: EVault,
  sourceAmount: bigint,
  targetAmount: bigint,
): LendSwapProjectionPlan => {
  const requests: ProjectedRatesRequest[] = []
  const sourceIndex = sourceVault ? requests.length : null
  if (sourceVault) {
    requests.push({
      vaultAddress: sourceVault.address,
      currentCash: sourceVault.totalCash,
      currentBorrows: sourceVault.totalBorrowed,
      cashDelta: -sourceAmount,
      borrowsDelta: 0n,
    })
  }
  const targetIndex = requests.length
  requests.push({
    vaultAddress: targetVault.address,
    currentCash: targetVault.totalCash,
    currentBorrows: targetVault.totalBorrowed,
    cashDelta: targetAmount,
    borrowsDelta: 0n,
  })
  return { requests, sourceIndex, targetIndex }
}

export const resolveLendSwapProjectedRates = (
  plan: LendSwapProjectionPlan,
  projectedRates: readonly (ProjectedRates | null)[],
): { source: ProjectedRates | null, target: ProjectedRates } | null => {
  if (projectedRates.length !== plan.requests.length || projectedRates.some(rate => rate === null)) return null
  const target = projectedRates[plan.targetIndex]
  if (!target) return null
  return {
    source: plan.sourceIndex === null ? null : projectedRates[plan.sourceIndex] ?? null,
    target,
  }
}
