import { getAddress, type Address } from 'viem'

const acknowledgedVaults = new Set<string>()

/** Session-scoped data only; execution still seals the exact acknowledged set. */
export const recordUnverifiedVaultAcknowledgement = (vaults: readonly string[]) => {
  vaults.forEach(vault => acknowledgedVaults.add(getAddress(vault).toLowerCase()))
}

export const hasUnverifiedVaultAcknowledgement = (vault: Address) =>
  acknowledgedVaults.has(getAddress(vault).toLowerCase())

export const clearUnverifiedVaultAcknowledgements = () => acknowledgedVaults.clear()
