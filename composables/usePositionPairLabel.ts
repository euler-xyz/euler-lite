import type { PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'

/**
 * Builds a pair assets label like "BOLD/USDC" or "BOLD & others/USDC"
 * based on whether the position has multiple collaterals.
 */
export function usePositionPairLabel(position: Ref<PortfolioBorrowPosition<VaultEntity> | undefined | null>) {
  return computed(() => {
    if (!position.value) return undefined
    const collateralSymbol = position.value.collateralVault?.asset.symbol
    const borrowSymbol = position.value.borrowVault?.asset.symbol
    if (!collateralSymbol || !borrowSymbol) return undefined
    const hasMultiple = position.value.collateralVaults.length > 1
    const label = hasMultiple ? `${collateralSymbol} & others` : collateralSymbol
    return `${label}/${borrowSymbol}`
  })
}
