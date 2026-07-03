import type { IHasVaultAddress, Portfolio, PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import { nanoToValue } from '~/utils/crypto-utils'
import { formatHealthScore } from '~/utils/string-utils'

export interface BatchHealthSummaryItem {
  label: string
  before?: string
  after: string
}

interface BuildBatchHealthSummaryOptions {
  basePortfolio?: Portfolio<VaultEntity>
  finalPortfolio?: Portfolio<VaultEntity>
  changedPositionKeys?: Set<string>
  revertedSubAccounts?: Set<string>
  positionTag: (subAccount?: string) => string | undefined
}

const normalizeAddressKey = (address?: string): string | undefined => {
  if (!address) return undefined
  try {
    return getAddress(address).toLowerCase()
  }
  catch {
    return undefined
  }
}

const getControllerKey = (
  portfolio: Portfolio<VaultEntity>,
  position: PortfolioBorrowPosition<VaultEntity>,
): string | undefined => {
  try {
    const subAccount = portfolio.account.getSubAccount(getAddress(position.subAccount))
    const controllers = (subAccount?.enabledControllers ?? [])
      .map(controller => getAddress(controller).toLowerCase())
      .sort()

    if (controllers?.length) return controllers.join(',')
  }
  catch {
    // Fall back to the borrow vault below if the sub-account lookup is malformed.
  }

  const borrowVault = (position.borrowVault as IHasVaultAddress | undefined)?.address
    ?? position.borrow?.vaultAddress
  return normalizeAddressKey(borrowVault)
}

const getBorrowPositionKey = (
  portfolio: Portfolio<VaultEntity>,
  position: PortfolioBorrowPosition<VaultEntity>,
): string | undefined => {
  const subAccount = normalizeAddressKey(position.subAccount)
  if (!subAccount) return undefined

  const controller = getControllerKey(portfolio, position)
  return `${subAccount}:${controller ?? 'unknown-controller'}`
}

const getBorrowPositionVaultAddress = (position: PortfolioBorrowPosition<VaultEntity>): string | undefined =>
  (position.borrowVault as IHasVaultAddress | undefined)?.address
  ?? position.borrow?.vaultAddress

const getBorrowPositionChangedKeys = (
  position: PortfolioBorrowPosition<VaultEntity> | undefined,
): string[] => {
  if (!position) return []

  const subAccount = normalizeAddressKey(position.subAccount)
  if (!subAccount) return []

  const keys = new Set<string>()
  const addVault = (vault?: string) => {
    const address = normalizeAddressKey(vault)
    if (address) keys.add(`${subAccount}:${address}`)
  }

  addVault(getBorrowPositionVaultAddress(position))
  addVault(position.collateral?.vaultAddress)
  addVault((position.collateralVault as IHasVaultAddress | undefined)?.address)
  for (const vault of position.collateralVaults ?? []) addVault(vault)
  for (const collateral of position.collaterals ?? []) {
    addVault(collateral.vaultAddress)
    addVault((collateral.vault as IHasVaultAddress | undefined)?.address)
  }

  return [...keys]
}

const isTouchedPosition = (
  position: PortfolioBorrowPosition<VaultEntity>,
  basePosition: PortfolioBorrowPosition<VaultEntity> | undefined,
  changedPositionKeys: Set<string> | undefined,
): boolean => {
  if (!changedPositionKeys) return true
  if (!changedPositionKeys.size) return false

  return [
    ...getBorrowPositionChangedKeys(position),
    ...getBorrowPositionChangedKeys(basePosition),
  ].some(key => changedPositionKeys.has(key))
}

export const buildBatchHealthSummary = ({
  basePortfolio,
  finalPortfolio,
  changedPositionKeys,
  revertedSubAccounts = new Set<string>(),
  positionTag,
}: BuildBatchHealthSummaryOptions): BatchHealthSummaryItem[] => {
  if (!basePortfolio || !finalPortfolio) return []

  const base = new Map<string, bigint | undefined>()
  const basePositions = new Map<string, PortfolioBorrowPosition<VaultEntity>>()
  for (const position of basePortfolio.borrows ?? []) {
    const key = getBorrowPositionKey(basePortfolio, position)
    if (key) {
      base.set(key, position.healthFactor)
      basePositions.set(key, position)
    }
  }

  const out: BatchHealthSummaryItem[] = []
  for (const position of finalPortfolio.borrows ?? []) {
    const subAccount = normalizeAddressKey(position.subAccount)
    if (subAccount && revertedSubAccounts.has(subAccount)) continue

    const key = getBorrowPositionKey(finalPortfolio, position)
    const beforeHf = key ? base.get(key) : undefined
    const basePosition = key ? basePositions.get(key) : undefined
    if (!isTouchedPosition(position, basePosition, changedPositionKeys)) continue
    if (beforeHf === undefined && position.healthFactor === undefined) continue
    if (beforeHf !== undefined && beforeHf === position.healthFactor) continue

    const before = beforeHf !== undefined ? formatHealthScore(nanoToValue(beforeHf, 18)) : undefined
    const after = position.healthFactor !== undefined ? formatHealthScore(nanoToValue(position.healthFactor, 18)) : 'Unknown'
    if (before !== undefined && before === after) continue

    out.push({
      label: positionTag(position.subAccount) ?? 'Position',
      before,
      after,
    })
  }

  return out
}
