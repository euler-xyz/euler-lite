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

export const buildBatchHealthSummary = ({
  basePortfolio,
  finalPortfolio,
  revertedSubAccounts = new Set<string>(),
  positionTag,
}: BuildBatchHealthSummaryOptions): BatchHealthSummaryItem[] => {
  if (!basePortfolio || !finalPortfolio) return []

  const base = new Map<string, bigint | undefined>()
  for (const position of basePortfolio.borrows ?? []) {
    const key = getBorrowPositionKey(basePortfolio, position)
    if (key) base.set(key, position.healthFactor)
  }

  const out: BatchHealthSummaryItem[] = []
  for (const position of finalPortfolio.borrows ?? []) {
    const subAccount = normalizeAddressKey(position.subAccount)
    if (subAccount && revertedSubAccounts.has(subAccount)) continue

    const key = getBorrowPositionKey(finalPortfolio, position)
    const beforeHf = key ? base.get(key) : undefined
    if (beforeHf !== undefined && beforeHf === position.healthFactor) continue

    out.push({
      label: positionTag(position.subAccount) ?? 'Position',
      before: beforeHf !== undefined ? formatHealthScore(nanoToValue(beforeHf, 18)) : undefined,
      after: formatHealthScore(nanoToValue(position.healthFactor ?? 0n, 18)),
    })
  }

  return out
}
