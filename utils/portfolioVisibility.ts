import { getAddress, type Address } from 'viem'

interface VisiblePortfolioCollateral {
  address: Address
  value?: {
    oracleMid: bigint
  }
}

interface VisiblePortfolioPosition {
  account: Address
  vaultAddress: Address
  borrowed: bigint
  liquidity?: {
    collaterals: readonly VisiblePortfolioCollateral[]
  }
}

interface VisiblePortfolioAccount {
  getSubAccount: (
    account: Address,
  ) => { enabledCollaterals: readonly Address[] } | undefined
}

export const isVisiblePortfolioPosition = (
  position: VisiblePortfolioPosition,
  account: VisiblePortfolioAccount,
  visibleVaults: ReadonlySet<string>,
): boolean => {
  if (!visibleVaults.has(getAddress(position.vaultAddress).toLowerCase())) {
    return false
  }

  if (position.borrowed === 0n) return true

  const primaryCollateralAddress = position.liquidity?.collaterals.reduce<
    VisiblePortfolioCollateral | undefined
  >(
    (primary, collateral) => {
      if (!primary) return collateral
      const collateralValue = collateral.value?.oracleMid ?? 0n
      const primaryValue = primary.value?.oracleMid ?? 0n
      return collateralValue > primaryValue
        ? collateral
        : primary
    },
    undefined,
  )?.address
  ?? account.getSubAccount(position.account)?.enabledCollaterals[0]

  if (!primaryCollateralAddress) return true

  return visibleVaults.has(getAddress(primaryCollateralAddress).toLowerCase())
}
