import type { ProjectedRatesRequest } from '~/utils/vault/apy'
import { BPS_BASE } from '~/entities/tuning-constants'
import { adjustForInterest } from '~/utils/adjust-for-interest'

const EXTERNAL_MIGRATION_INTEREST_BUFFER_BPS = 100n

/** Target-vault debt opened by a same-asset refinance after execution cushions. */
export const getSameAssetRefinanceBorrowAmount = (currentDebt: bigint, isExternalSource: boolean) => {
  if (currentDebt <= 0n) return 0n
  return isExternalSource
    ? (currentDebt * (BPS_BASE + EXTERNAL_MIGRATION_INTEREST_BUFFER_BPS)) / BPS_BASE
    : adjustForInterest(currentDebt)
}

export interface RefinanceRateVault {
  address: string
  totalCash: bigint
  totalBorrowed: bigint
}

export interface RefinanceCollateralRateDelta {
  vault: RefinanceRateVault
  cashDelta: bigint
}

export interface RefinanceDebtRateDelta {
  vault: RefinanceRateVault
  borrowsDelta: bigint
}

export interface RefinanceProjectedRateRequest {
  address: string
  request: ProjectedRatesRequest
}

const normalizeAddress = (address: string) => address.toLowerCase()

export const getRefinanceRewardCollateralAddresses = (
  currentCollaterals: readonly { vaultAddress: string, assets: bigint }[],
  sourceAddress?: string,
  targetAddress?: string,
): string[] => {
  const addresses = new Set(
    currentCollaterals
      .filter(collateral => collateral.assets > 0n)
      .map(collateral => normalizeAddress(collateral.vaultAddress)),
  )

  if (!addresses.size && sourceAddress) addresses.add(normalizeAddress(sourceAddress))
  if (targetAddress) {
    if (sourceAddress) addresses.delete(normalizeAddress(sourceAddress))
    addresses.add(normalizeAddress(targetAddress))
  }

  return [...addresses]
}

export const buildRefinanceProjectedRateRequests = (
  collateralDeltas: readonly RefinanceCollateralRateDelta[],
  debtDeltas: readonly RefinanceDebtRateDelta[] = [],
): RefinanceProjectedRateRequest[] => {
  const merged = new Map<string, { vault: RefinanceRateVault, cashDelta: bigint, borrowsDelta: bigint }>()
  const add = (vault: RefinanceRateVault, cashDelta: bigint, borrowsDelta: bigint) => {
    const address = normalizeAddress(vault.address)
    const current = merged.get(address)
    merged.set(address, {
      vault,
      cashDelta: (current?.cashDelta ?? 0n) + cashDelta,
      borrowsDelta: (current?.borrowsDelta ?? 0n) + borrowsDelta,
    })
  }

  for (const delta of collateralDeltas) add(delta.vault, delta.cashDelta, 0n)
  for (const debtDelta of debtDeltas) {
    if (debtDelta.borrowsDelta !== 0n) {
      add(debtDelta.vault, -debtDelta.borrowsDelta, debtDelta.borrowsDelta)
    }
  }

  return [...merged.entries()]
    .filter(([, delta]) => delta.cashDelta !== 0n || delta.borrowsDelta !== 0n)
    .map(([address, delta]) => ({
      address,
      request: {
        vaultAddress: delta.vault.address,
        currentCash: delta.vault.totalCash,
        currentBorrows: delta.vault.totalBorrowed,
        cashDelta: delta.cashDelta,
        borrowsDelta: delta.borrowsDelta,
      },
    }))
}
