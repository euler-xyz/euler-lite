import {
  isEVault,
  isSecuritizeCollateralVault,
  type EVault,
  type PortfolioBorrowPosition,
  type SecuritizeCollateralVault,
  type VaultEntity,
} from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import { areTokenAddressesCorrelatedByTags, type TokenCategoryTagSource } from '~/utils/token-categories'

export type RoeCollateralVault = EVault | SecuritizeCollateralVault

export const isRoeCollateralVault = (vault: VaultEntity | RoeCollateralVault | null | undefined): vault is RoeCollateralVault =>
  !!vault && (isEVault(vault) || isSecuritizeCollateralVault(vault))

const normalizeVaultAddress = (vault: RoeCollateralVault): string => {
  try {
    return getAddress(vault.address).toLowerCase()
  }
  catch {
    return vault.address.toLowerCase()
  }
}

export const mergeRoeCollateralVaults = (
  vaults: Array<RoeCollateralVault | null | undefined>,
): RoeCollateralVault[] => {
  const merged = new Map<string, RoeCollateralVault>()
  for (const vault of vaults) {
    if (!vault) continue
    merged.set(normalizeVaultAddress(vault), vault)
  }
  return [...merged.values()]
}

export const getPositionRoeCollateralVaults = (
  position: PortfolioBorrowPosition<VaultEntity> | null | undefined,
  fallback?: RoeCollateralVault | null,
): RoeCollateralVault[] => {
  if (!position) return fallback ? [fallback] : []

  const collaterals = position.collaterals.flatMap((collateralPosition) => {
    const vault = collateralPosition.vault
    return isRoeCollateralVault(vault) ? [vault] : []
  })

  return collaterals.length ? mergeRoeCollateralVaults(collaterals) : fallback ? [fallback] : []
}

export const areRoeCollateralVaultsCorrelatedWithBorrow = (
  collaterals: readonly RoeCollateralVault[],
  borrowVault: EVault | null | undefined,
  getTokenCategoryTags: (address: string) => TokenCategoryTagSource,
): boolean => {
  if (!borrowVault || !collaterals.length) return false
  return collaterals.every(collateral =>
    areTokenAddressesCorrelatedByTags(
      collateral.asset.address,
      borrowVault.asset.address,
      getTokenCategoryTags,
    ),
  )
}
