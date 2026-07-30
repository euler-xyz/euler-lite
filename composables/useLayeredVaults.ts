import { shallowRef } from 'vue'
import { getAddress } from 'viem'
import type { Account, IHasVaultAddress, VaultEntity } from '@eulerxyz/euler-v2-sdk'

export type LayeredVaultMap = Record<string, VaultEntity>

export const activeLayerVaultsRef = shallowRef<LayeredVaultMap>({})

const vaultKey = (address: string): string | undefined => {
  try {
    return getAddress(address).toLowerCase()
  }
  catch {
    return undefined
  }
}

export const collectAccountVaults = (
  account: Account<IHasVaultAddress> | undefined,
): VaultEntity[] => {
  if (!account) return []
  const vaults: VaultEntity[] = []

  for (const subAccount of Object.values(account.subAccounts)) {
    for (const position of subAccount?.positions ?? []) {
      if (position.vault) vaults.push(position.vault as VaultEntity)
      if (position.liquidity?.vault) vaults.push(position.liquidity.vault as VaultEntity)
      for (const collateral of position.liquidity?.collaterals ?? []) {
        if (collateral.vault) vaults.push(collateral.vault as VaultEntity)
      }
    }
  }

  return vaults
}

export const mergeLayeredVaults = (
  current: LayeredVaultMap,
  vaults: readonly VaultEntity[],
): LayeredVaultMap => {
  const next = { ...current }
  for (const vault of vaults) {
    const key = vaultKey(vault.address)
    if (key) next[key] = vault
  }
  return next
}

export const getLayeredVault = <TVault extends IHasVaultAddress>(
  address: string | undefined,
  fallback?: TVault,
): TVault | undefined => {
  const key = address ? vaultKey(address) : undefined
  return (key ? activeLayerVaultsRef.value[key] as unknown as TVault | undefined : undefined) ?? fallback
}

export const useLayeredVaults = () => {
  const { getOrFetch } = useVaultRegistry()

  const resolveLayeredVault = async <TVault extends VaultEntity>(
    address: string,
    fallback?: TVault,
  ): Promise<TVault | undefined> => {
    const layered = getLayeredVault(address, fallback)
    if (layered) return layered
    return await getOrFetch(address) as TVault | undefined
  }

  return {
    getLayeredVault,
    resolveLayeredVault,
  }
}
