import type { EVault, EulerEarn, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'

const getVaultWithdrawCapacity = (vault: EVault | SecuritizeCollateralVault | EulerEarn): bigint => {
  if ('availableAssets' in vault) return vault.availableAssets
  if (vault.type === 'SecuritizeCollateral') return vault.totalAssets
  return vault.availableLiquidity
}

export const getCashLimitedWithdrawAmount = (
  userWithdrawableAssets: bigint,
  vault: EVault | SecuritizeCollateralVault | EulerEarn | undefined,
): bigint => {
  if (!vault) return userWithdrawableAssets
  const capacity = getVaultWithdrawCapacity(vault)
  return userWithdrawableAssets < capacity ? userWithdrawableAssets : capacity
}
