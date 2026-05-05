export const getVaultSupplyApy = (vault: any): number => {
  if (!vault) return 0
  if ('interestRates' in vault) return vault.interestRates.supplyAPY
  if ('supplyApy1h' in vault) return vault.supplyApy1h ?? 0
  return 0
}

export const getVaultBorrowApy = (vault: any): number => {
  if (!vault || !('interestRates' in vault)) return 0
  return vault.interestRates.borrowAPY
}
