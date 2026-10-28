import { withVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'

export const getVaultSupplyApy = (vault: any): number => {
  if (!vault) return 0
  if ('interestRates' in vault) return vault.interestRates.supplyAPY
  if ('supplyApy' in vault) return vault.supplyApy ?? 0
  return 0
}

export const getVaultTotalSupplyApy = (
  vault: Parameters<typeof getVaultSupplyApy>[0],
  intrinsicApyEnabled: boolean,
  supplyRewardApy = 0,
): number => withVaultIntrinsicApy(
  getVaultSupplyApy(vault),
  vault,
  intrinsicApyEnabled,
) + supplyRewardApy

export const getVaultBorrowApy = (vault: any): number => {
  if (!vault || !('interestRates' in vault)) return 0
  return vault.interestRates.borrowAPY
}

export const getVaultAvailableLiquidity = (vault: any): bigint => {
  if (!vault) return 0n
  if (typeof vault.totalAssets === 'bigint' && typeof vault.totalBorrowed === 'bigint') {
    const totalAssets = vault.totalAssets as bigint
    const totalBorrowed = vault.totalBorrowed as bigint
    return totalAssets >= totalBorrowed ? totalAssets - totalBorrowed : 0n
  }
  if (typeof vault.availableLiquidity === 'bigint') return vault.availableLiquidity as bigint
  return 0n
}

export const getVaultUtilization = (vault: any): number => {
  if (!vault) return 0
  const totalAssets = typeof vault.totalAssets === 'bigint' ? vault.totalAssets as bigint : 0n
  const totalBorrowed = typeof vault.totalBorrowed === 'bigint'
    ? vault.totalBorrowed as bigint
    : typeof vault.borrow === 'bigint'
      ? vault.borrow as bigint
      : 0n

  if (totalAssets <= 0n || totalBorrowed <= 0n) return 0

  return Number(((Number(totalBorrowed) / Number(totalAssets)) * 100).toFixed(2))
}

export const formatMarketAvailability = (count: number) => {
  return count ? `Yes in ${count} ${count === 1 ? 'market' : 'markets'}` : 'No'
}
