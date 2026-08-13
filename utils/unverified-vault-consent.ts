import { flattenBatchEntries, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'

export interface UnverifiedVaultConsentTarget {
  address: string
  name: string
}

interface VaultMetadata {
  shares?: { name?: string }
  asset?: { symbol?: string }
}

export const collectUnverifiedVaultConsentTargets = (
  plans: Array<TransactionPlan | undefined>,
  getVault: (address: string) => unknown,
  isVerifiedVault: (address: string) => boolean,
): UnverifiedVaultConsentTarget[] => {
  const vaults = new Map<string, string>()
  for (const plan of plans) {
    for (const item of plan ?? []) {
      if (item.type !== 'evcBatch') continue
      for (const batchItem of flattenBatchEntries(item.items)) {
        try {
          const address = getAddress(batchItem.targetContract)
          const vault = getVault(address) as VaultMetadata | undefined
          if (!vault || isVerifiedVault(address)) continue
          const name = vault.shares?.name || vault.asset?.symbol || address
          vaults.set(address.toLowerCase(), name)
        }
        catch { /* Ignore malformed or non-address batch targets. */ }
      }
    }
  }
  return [...vaults]
    .map(([address, name]) => ({ address, name }))
    .sort((a, b) => a.address.localeCompare(b.address))
}

export const buildUnverifiedVaultConsentKey = (
  chainId: number | undefined,
  account: string | undefined,
  vaults: readonly Pick<UnverifiedVaultConsentTarget, 'address'>[],
): string => JSON.stringify([
  chainId ?? null,
  account?.toLowerCase() ?? '',
  vaults.map(vault => vault.address.toLowerCase()).sort(),
])
