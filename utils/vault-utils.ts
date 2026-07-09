import { getAddress } from 'viem'

export const isSameVault = (
  vaultA: { address: string } | undefined,
  vaultB: { address: string } | undefined,
): boolean => {
  if (!vaultA || !vaultB) return false
  try {
    return getAddress(vaultA.address) === getAddress(vaultB.address)
  }
  catch {
    return false
  }
}

export const isSameUnderlyingAsset = (
  vaultA: { asset: { address: string } } | undefined,
  vaultB: { asset: { address: string } } | undefined,
): boolean => {
  if (!vaultA || !vaultB) return false
  try {
    return getAddress(vaultA.asset.address) === getAddress(vaultB.asset.address)
  }
  catch {
    return false
  }
}

/**
 * Convert a vault share amount to its underlying assets at the vault's current
 * exchange rate (ERC-4626 `convertToAssets`, floor-rounded). Non-positive shares
 * yield 0; a vault with no shares yet falls back to a 1:1 rate.
 */
export const convertVaultSharesToAssets = (
  vault: { totalShares: bigint, totalAssets: bigint },
  sharesAmount: bigint,
): bigint => {
  if (sharesAmount <= 0n) return 0n
  if (vault.totalShares <= 0n) return sharesAmount
  return (sharesAmount * vault.totalAssets) / vault.totalShares
}
