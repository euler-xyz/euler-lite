import { getAddress, type Address } from 'viem'
import type { Account, IHasVaultAddress } from '@eulerxyz/euler-v2-sdk'
import { toCanonicalValue } from '../domain/canonical'
import type { SnapshotDependencyResult, SnapshotLoaderDependencies } from './snapshot-loader'
import type { PlanningRequirements } from './requirements'

export const snapshotAccount = (account: Account<IHasVaultAddress>) => ({
  chainId: account.chainId,
  owner: getAddress(account.owner),
  subAccounts: Object.values(account.subAccounts).filter(Boolean).map(subAccount => ({
    account: getAddress(subAccount!.account),
    owner: getAddress(subAccount!.owner),
    timestamp: subAccount!.timestamp,
    lastAccountStatusCheckTimestamp: subAccount!.lastAccountStatusCheckTimestamp,
    enabledControllers: subAccount!.enabledControllers.map(getAddress),
    enabledCollaterals: subAccount!.enabledCollaterals.map(getAddress),
    positions: subAccount!.positions.map(position => ({
      account: getAddress(position.account),
      vaultAddress: getAddress(position.vaultAddress),
      asset: getAddress(position.asset),
      shares: position.shares,
      assets: position.assets,
      borrowed: position.borrowed,
      isController: position.isController,
      isCollateral: position.isCollateral,
      balanceForwarderEnabled: position.balanceForwarderEnabled,
    })),
  })),
})

export const snapshotVaults = (values: readonly {
  address: Address
  asset?: { address?: Address }
  totalShares?: bigint
  totalAssets?: bigint
}[]) => values.map(vault => ({
  address: getAddress(vault.address),
  ...(vault.asset?.address ? { asset: getAddress(vault.asset.address) } : {}),
  ...(vault.totalShares === undefined ? {} : { totalShares: vault.totalShares }),
  ...(vault.totalAssets === undefined ? {} : { totalAssets: vault.totalAssets }),
}))

export interface AppSnapshotContext {
  account: Account<IHasVaultAddress>
  getBlockNumber(): Promise<bigint>
  dataVersion: string
  labelsVersion: string
}

/** Every dependency in one preparation instance is stamped with one block. */
export const createAppSnapshotDependencies = (context: AppSnapshotContext): SnapshotLoaderDependencies => {
  let blockPromise: Promise<bigint> | undefined
  const block = () => blockPromise ??= context.getBlockNumber()
  return {
    version(key) {
      return key.startsWith('vault:')
        ? `${context.dataVersion}:${context.labelsVersion}`
        : context.dataVersion
    },
    async load(key: string, requirements: PlanningRequirements): Promise<SnapshotDependencyResult> {
      const observedBlock = await block()
      const [kind, rawValue] = key.split(':', 2) as [string, string]
      const address = rawValue && /^0x[0-9a-f]{40}$/i.test(rawValue) ? getAddress(rawValue) : undefined
      let value: unknown
      let version = context.dataVersion
      if (kind === 'account') {
        if (!address || !requirements.accounts.some(candidate => candidate === address)) throw new Error(`Unexpected account snapshot key ${key}`)
        value = snapshotAccount(context.account)
      }
      else if (kind === 'vault') {
        if (!address) throw new Error(`Malformed vault snapshot key ${key}`)
        const vault = await useVaultRegistry().getOrFetch(address)
        if (!vault?.asset?.address) throw new Error(`Vault snapshot is unavailable for ${address}`)
        const type = useVaultRegistry().getType(address)
        if (!type) throw new Error(`Vault type is unavailable for ${address}`)
        value = {
          chainId: vault.chainId,
          address: getAddress(vault.address),
          type,
          asset: { address: getAddress(vault.asset.address), symbol: vault.asset.symbol, decimals: vault.asset.decimals },
          totalShares: vault.totalShares,
          totalAssets: vault.totalAssets,
        }
        version = `${context.dataVersion}:${context.labelsVersion}`
      }
      else if (kind === 'asset') {
        if (!address) throw new Error(`Malformed asset snapshot key ${key}`)
        const token = useTokenList().getTokenByAddress(address)
        if (!token) throw new Error(`Asset snapshot is unavailable for ${address}`)
        value = { address: getAddress(token.address), symbol: token.symbol, name: token.name, decimals: token.decimals }
      }
      else if (kind === 'contract') {
        if (!address) throw new Error(`Malformed contract snapshot key ${key}`)
        value = { address }
      }
      else if (kind === 'quote') {
        value = { quoteId: rawValue }
      }
      else throw new Error(`Unsupported planning snapshot key ${key}`)
      return { value: toCanonicalValue(value), observedBlock, version, freshUntil: Date.now() + 60_000 }
    },
  }
}

export const assertRuntimeAccountContext = (account: Account<IHasVaultAddress>, owner: Address, chainId: number) => {
  if (getAddress(account.owner) !== getAddress(owner) || account.chainId !== chainId) {
    throw new Error('Eager account snapshot belongs to another wallet context')
  }
}
