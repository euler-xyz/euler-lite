import {
  isEVault,
  isSecuritizeCollateralVault,
  type PortfolioBorrowPosition,
  type VaultEntity,
} from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import { areTokenAddressesInSameCorrelatedCategory, type TokenCategoryTagSource } from '~/utils/token-categories'

export type RoeCollateralVault = {
  address: string
  asset: {
    address: string
  }
}

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

const normalizeAddress = (address: string): string => {
  try {
    return getAddress(address).toLowerCase()
  }
  catch {
    return address.toLowerCase()
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

export type PositionRoeCollateralVaults = {
  vaults: RoeCollateralVault[]
  isComplete: boolean
}

export const resolvePositionRoeCollateralVaults = (
  position: PortfolioBorrowPosition<VaultEntity> | null | undefined,
  fallback?: RoeCollateralVault | null,
): PositionRoeCollateralVaults => {
  if (!position) {
    return { vaults: fallback ? [fallback] : [], isComplete: false }
  }

  const collaterals = mergeRoeCollateralVaults(position.collaterals.flatMap((collateralPosition) => {
    const vault = collateralPosition.vault
    return isRoeCollateralVault(vault) ? [vault] : []
  }))

  const vaults = collaterals.length ? collaterals : fallback ? [fallback] : []
  const expectedAddresses = new Set(
    position.collateralVaults
      .map(address => normalizeAddress(address))
      .filter(Boolean),
  )

  const resolvedAddresses = new Set(vaults.map(vault => normalizeVaultAddress(vault)))
  const isComplete = expectedAddresses.size === 0
    ? vaults.length > 0
    : [...expectedAddresses].every(address => resolvedAddresses.has(address))

  return { vaults, isComplete }
}

export const getPositionRoeCollateralVaults = (
  position: PortfolioBorrowPosition<VaultEntity> | null | undefined,
  fallback?: RoeCollateralVault | null,
): RoeCollateralVault[] => resolvePositionRoeCollateralVaults(position, fallback).vaults

export const areRoeCollateralVaultsCorrelatedWithBorrow = (
  collaterals: readonly RoeCollateralVault[],
  borrowVault: RoeCollateralVault | null | undefined,
  getTokenCategoryTags: (address: string) => TokenCategoryTagSource,
): boolean => {
  if (!borrowVault || !collaterals.length) return false
  return areTokenAddressesInSameCorrelatedCategory(
    [
      ...collaterals.map(collateral => collateral.asset.address),
      borrowVault.asset.address,
    ],
    getTokenCategoryTags,
  )
}
