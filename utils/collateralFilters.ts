import { getAddress, type Address } from 'viem'

export function shouldIncludeWalletCollateral({
  balance,
  vaultAddress,
  primaryCollateralAddress,
}: {
  balance: bigint
  vaultAddress: Address
  primaryCollateralAddress: Address | ''
}) {
  return balance > 0n || (!!primaryCollateralAddress && getAddress(vaultAddress) === primaryCollateralAddress)
}
