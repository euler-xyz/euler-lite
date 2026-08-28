import { getAddress, type Address } from 'viem'

export interface UnverifiedVaultAcknowledgementContext {
  chainId: number
  account: string
  operation: string
  vaults: readonly string[]
}

const acknowledgedContexts = new Map<string, Readonly<{
  chainId: number
  account: string
  operation: string
  vaults: readonly string[]
}>>()

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
  const normalized = Object.freeze({
    chainId: context.chainId,
    account: getAddress(context.account).toLowerCase(),
    operation: context.operation,
    vaults: Object.freeze(normalizeVaults(context.vaults)),
  })
  acknowledgedContexts.set(unverifiedVaultAcknowledgementKey(context), normalized)
}

/** Final-plan check: consent cannot cross account or chain boundaries. */
export const hasUnverifiedVaultAcknowledgement = (
  vault: Address,
  context: { chainId: number, account: Address },
) => {
  const normalizedVault = getAddress(vault).toLowerCase()
  const normalizedAccount = getAddress(context.account).toLowerCase()
  return [...acknowledgedContexts.values()].some(acknowledgement =>
    acknowledgement.chainId === context.chainId
    && acknowledgement.account === normalizedAccount
    && acknowledgement.vaults.includes(normalizedVault),
  )
}

export const clearUnverifiedVaultAcknowledgements = () => acknowledgedContexts.clear()
