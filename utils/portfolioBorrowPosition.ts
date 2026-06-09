import {
  isEVault,
  isSecuritizeCollateralVault,
  type PortfolioBorrowPosition,
  type VaultEntity,
} from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Address } from 'viem'

export const isRenderablePortfolioBorrowPosition = (
  position: PortfolioBorrowPosition<VaultEntity>,
): boolean =>
  !!position.borrowVault
  && !!position.collateralVault
  && (isEVault(position.collateralVault) || isSecuritizeCollateralVault(position.collateralVault))

export const getBorrowPositionCollateralAddresses = (
  position: PortfolioBorrowPosition<VaultEntity>,
): Address[] => {
  const seen = new Set<string>()
  const addresses = [
    ...position.collateralVaults,
    ...position.collaterals.map(collateral => collateral.vaultAddress),
    ...((position.borrow.liquidity?.collaterals ?? []).map(collateral => collateral.address)),
    position.collateral?.vaultAddress,
  ]

  return addresses.flatMap((address) => {
    if (typeof address !== 'string') return []
    try {
      const checksumAddress = getAddress(address)
      const key = checksumAddress.toLowerCase()
      if (seen.has(key)) return []
      seen.add(key)
      return [checksumAddress]
    }
    catch {
      return []
    }
  })
}
