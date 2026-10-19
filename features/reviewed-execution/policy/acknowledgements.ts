import { getAddress } from 'viem'

export interface UnverifiedVaultAcknowledgementContext {
  chainId: number
  account: string
  operation: string
  vaults: readonly string[]
}

const acknowledgedContexts = new Set<string>()
const acknowledgedDeprecatedDeposits = new Set<string>()

const normalizeVaults = (vaults: readonly string[]) =>
  [...new Set(vaults.map(vault => getAddress(vault).toLowerCase()))].sort()

export const unverifiedVaultAcknowledgementKey = (context: UnverifiedVaultAcknowledgementContext) =>
  JSON.stringify([
    context.chainId,
    getAddress(context.account).toLowerCase(),
    context.operation,
    normalizeVaults(context.vaults),
  ])

/** Session-scoped acknowledgement for one exact UI operation context. */
export const recordUnverifiedVaultAcknowledgement = (context: UnverifiedVaultAcknowledgementContext) => {
  acknowledgedContexts.add(unverifiedVaultAcknowledgementKey(context))
}

/** Final-plan check: consent must match the exact account, chain, operation, and vault set. */
export const hasUnverifiedVaultAcknowledgement = (context: UnverifiedVaultAcknowledgementContext) =>
  acknowledgedContexts.has(unverifiedVaultAcknowledgementKey(context))

export const clearUnverifiedVaultAcknowledgements = () => acknowledgedContexts.clear()

export const deprecatedDepositAcknowledgementKey = (context: UnverifiedVaultAcknowledgementContext) =>
  `deprecated-deposit:${unverifiedVaultAcknowledgementKey(context)}`

/** Separate consent: an earlier unverified-vault acknowledgement never accepts deprecation. */
export const recordDeprecatedDepositAcknowledgement = (context: UnverifiedVaultAcknowledgementContext) => {
  acknowledgedDeprecatedDeposits.add(deprecatedDepositAcknowledgementKey(context))
}

export const hasDeprecatedDepositAcknowledgement = (context: UnverifiedVaultAcknowledgementContext) =>
  acknowledgedDeprecatedDeposits.has(deprecatedDepositAcknowledgementKey(context))

export const clearDeprecatedDepositAcknowledgements = () => acknowledgedDeprecatedDeposits.clear()
