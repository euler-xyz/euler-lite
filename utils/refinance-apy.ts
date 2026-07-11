import type { ProjectedRatesRequest } from '~/utils/vault/apy'

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

export const buildRefinanceProjectedRateRequests = (
  collateralDeltas: readonly RefinanceCollateralRateDelta[],
  debtDelta?: RefinanceDebtRateDelta,
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
  if (debtDelta && debtDelta.borrowsDelta !== 0n) {
    add(debtDelta.vault, -debtDelta.borrowsDelta, debtDelta.borrowsDelta)
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
