import type { Address } from 'viem'
import type { EVault, EulerEarn, SecuritizeCollateralVault, BorrowVaultPair } from './types'
import {
  vaultConvertToAssetsAbi,
  vaultConvertToSharesAbi,
  vaultMaxWithdrawAbi,
  vaultPreviewWithdrawAbi,
} from '~/abis/vault'
import { INTEREST_RATE_MODEL_TYPE } from '~/entities/constants'

export const isCyclicalNoteVault = (
  vault: EVault | SecuritizeCollateralVault | null | undefined,
): boolean => {
  if (!vault) return false
  const type = (vault as { interestRateModel?: { type?: unknown } }).interestRateModel?.type
  return typeof type === 'number' && type === INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY
}

export const getBorrowVaultsByMap = (vaultsMap: Map<string, EVault>) => {
  const arr: BorrowVaultPair[] = []
  const list = [...vaultsMap.values()]
  list.forEach((vault) => {
    vault.collaterals.forEach((c) => {
      if (c.borrowLTV <= 0) {
        return
      }
      const cVault = vaultsMap.get(c.address)
      arr.push({
        borrow: vault,
        collateral: cVault!,
        ltv: c,
      })
    })
  })
  return arr.filter(o => !!o && o?.collateral)
}
export const getBorrowVaultPairByMapAndAddresses = (
  vaultsMap: Map<string, EVault>,
  collateralAddress: string,
  borrowAddress: string,
): BorrowVaultPair => {
  let obj: BorrowVaultPair | undefined = undefined
  const borrowVault = vaultsMap.get(borrowAddress)
  if (!borrowVault) {
    throw '[getBorrowVaultPairByMapAndAddresses]: Borrow vault not found'
  }
  borrowVault.collaterals.forEach((c) => {
    if (c.address !== collateralAddress) {
      return
    }
    const cVault = vaultsMap.get(c.address)!
    obj = {
      borrow: borrowVault,
      collateral: cVault,
      ltv: c,
    } as BorrowVaultPair
  })

  if (!obj) {
    throw '[getBorrowVaultPairByMapAndAddresses]: Vault pair not found'
  }

  return obj
}

export const convertSharesToAssets = (
  vaultAddress: string,
  sharesAmount: bigint,
): Promise<bigint> => {
  const { client: rpcClient } = useRpcClient()
  return rpcClient.value!.readContract({
    address: vaultAddress as Address,
    abi: vaultConvertToAssetsAbi,
    functionName: 'convertToAssets',
    args: [sharesAmount],
  }).catch(() => 0n) as Promise<bigint>
}
export const convertAssetsToShares = (
  vaultAddress: string,
  assetsAmount: bigint,
): Promise<bigint> => {
  const { client: rpcClient } = useRpcClient()
  return rpcClient.value!.readContract({
    address: vaultAddress as Address,
    abi: vaultConvertToSharesAbi,
    functionName: 'convertToShares',
    args: [assetsAmount],
  }).catch(() => 0n) as Promise<bigint>
}
export const previewWithdraw = (vaultAddress: string, assetsAmount: bigint): Promise<bigint> => {
  const { client: rpcClient } = useRpcClient()
  return rpcClient.value!.readContract({
    address: vaultAddress as Address,
    abi: vaultPreviewWithdrawAbi,
    functionName: 'previewWithdraw',
    args: [assetsAmount],
  }).catch(() => 0n) as Promise<bigint>
}
export const getMaxWithdraw = (vaultAddress: string, account: string): Promise<bigint> => {
  const { client: rpcClient } = useRpcClient()
  return rpcClient.value!.readContract({
    address: vaultAddress as Address,
    abi: vaultMaxWithdrawAbi,
    functionName: 'maxWithdraw',
    args: [account as Address],
  }) as Promise<bigint>
}

// What the vault can actually pay out right now in its underlying asset:
// - EVault: only available liquidity; the rest is lent out.
// - SecuritizeCollateralVault: the whole supply; these are collateral-only.
// - EulerEarn: assets reachable across allocated strategies.
const getVaultWithdrawCapacity = (vault: EVault | SecuritizeCollateralVault | EulerEarn): bigint => {
  if ('availableAssets' in vault) return vault.availableAssets
  if (vault.type === 'SecuritizeCollateral') return vault.totalAssets
  return vault.availableLiquidity
}

export const getCashLimitedWithdrawAmount = (
  userWithdrawableAssets: bigint,
  vault: EVault | SecuritizeCollateralVault | EulerEarn | undefined,
): bigint => {
  if (!vault) return userWithdrawableAssets
  const capacity = getVaultWithdrawCapacity(vault)
  return userWithdrawableAssets < capacity ? userWithdrawableAssets : capacity
}
