const asBigint = (value: unknown): bigint | null =>
  typeof value === 'bigint' ? value : null

const asRecord = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' ? value as Record<string, unknown> : null

export const getVaultSupplyApy = (vault: unknown): number => {
  const source = asRecord(vault)
  if (!source) return 0

  const interestRates = asRecord(source.interestRates)
  if (typeof interestRates?.supplyAPY === 'number') return interestRates.supplyAPY
  return typeof source.supplyApy1h === 'number' ? source.supplyApy1h : 0
}

export const getVaultBorrowApy = (vault: unknown): number => {
  const source = asRecord(vault)
  const interestRates = asRecord(source?.interestRates)
  return typeof interestRates?.borrowAPY === 'number' ? interestRates.borrowAPY : 0
}

export const getVaultAvailableLiquidity = (vault: unknown): bigint => {
  const source = asRecord(vault)
  if (!source) return 0n

  const totalAssets = asBigint(source.totalAssets)
  const totalBorrowed = asBigint(source.totalBorrowed)
  if (totalAssets !== null && totalBorrowed !== null) {
    return totalAssets >= totalBorrowed ? totalAssets - totalBorrowed : 0n
  }
  const availableLiquidity = asBigint(source.availableLiquidity)
  if (availableLiquidity !== null) return availableLiquidity
  return 0n
}

export const getVaultUtilization = (vault: unknown): number => {
  const source = asRecord(vault)
  if (!source) return 0

  const totalAssets = asBigint(source.totalAssets) ?? 0n
  const totalBorrowed = asBigint(source.totalBorrowed) ?? asBigint(source.borrow) ?? 0n

  if (totalAssets <= 0n || totalBorrowed <= 0n) return 0

  return Number(((Number(totalBorrowed) / Number(totalAssets)) * 100).toFixed(2))
}

export type VaultUtilizationDelta = {
  amount: bigint
  direction: 'borrow' | 'repay' | 'none'
}

export const getVaultUtilizationDeltaActionLabel = (delta: VaultUtilizationDelta | null | undefined): string | null => {
  if (!delta) return null
  if (delta.direction === 'borrow') return 'Borrow/Withdraw'
  if (delta.direction === 'repay') return 'Deposit/Repay'
  return 'No change'
}

export const getVaultUtilizationDelta = (vault: unknown, targetUtilizationPercent: number): VaultUtilizationDelta | null => {
  const source = asRecord(vault)
  if (!source || !Number.isFinite(targetUtilizationPercent)) return null

  const totalAssets = asBigint(source.totalAssets) ?? 0n
  const totalBorrowed = asBigint(source.totalBorrowed) ?? asBigint(source.borrow) ?? 0n

  if (totalAssets <= 0n) return null

  const clampedPercent = Math.min(100, Math.max(0, targetUtilizationPercent))
  const percentScale = 10_000n
  const utilizationUnits = BigInt(Math.round(clampedPercent * Number(percentScale)))
  const targetBorrowed = totalAssets * utilizationUnits / (100n * percentScale)

  if (targetBorrowed > totalBorrowed) {
    return { amount: targetBorrowed - totalBorrowed, direction: 'borrow' }
  }
  if (targetBorrowed < totalBorrowed) {
    return { amount: totalBorrowed - targetBorrowed, direction: 'repay' }
  }
  return { amount: 0n, direction: 'none' }
}

export const formatMarketAvailability = (count: number) => {
  return count ? `Yes in ${count} ${count === 1 ? 'market' : 'markets'}` : 'No'
}
