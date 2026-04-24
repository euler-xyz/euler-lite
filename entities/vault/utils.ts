import type { Address } from 'viem'
import type { Vault, SecuritizeVault, BorrowVaultPair } from './types'
import {
  vaultConvertToAssetsAbi,
  vaultConvertToSharesAbi,
  vaultMaxWithdrawAbi,
  vaultPreviewWithdrawAbi,
} from '~/abis/vault'
import { INTEREST_RATE_MODEL_TYPE } from '~/entities/constants'

export const isCyclicalNoteVault = (
  vault: Vault | SecuritizeVault | null | undefined,
): boolean => {
  if (!vault || !('irmInfo' in vault)) return false
  const type = vault.irmInfo?.interestRateModelInfo?.interestRateModelType
  return typeof type === 'number' && type === INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY
}

export const getBorrowVaultsByMap = (vaultsMap: Map<string, Vault>) => {
  const arr: BorrowVaultPair[] = []
  const list = [...vaultsMap.values()]
  list.forEach((vault) => {
    vault.collateralLTVs.forEach((c) => {
      if (c.borrowLTV <= 0n) {
        return
      }
      const cVault = vaultsMap.get(c.collateral)
      arr.push({
        borrow: vault,
        collateral: cVault!,
        borrowLTV: c.borrowLTV,
        liquidationLTV: c.liquidationLTV,
        initialLiquidationLTV: c.initialLiquidationLTV,
        targetTimestamp: c.targetTimestamp,
        rampDuration: c.rampDuration,
      })
    })
  })
  return arr.filter(o => !!o && o?.collateral)
}
export const getBorrowVaultPairByMapAndAddresses = (
  vaultsMap: Map<string, Vault>,
  collateralAddress: string,
  borrowAddress: string,
): BorrowVaultPair => {
  let obj: BorrowVaultPair | undefined = undefined
  const borrowVault = vaultsMap.get(borrowAddress)
  if (!borrowVault) {
    throw '[getBorrowVaultPairByMapAndAddresses]: Borrow vault not found'
  }
  borrowVault.collateralLTVs.forEach((c) => {
    if (c.collateral !== collateralAddress) {
      return
    }
    const cVault = vaultsMap.get(c.collateral)!
    obj = {
      borrow: borrowVault,
      collateral: cVault,
      borrowLTV: c.borrowLTV,
      liquidationLTV: c.liquidationLTV,
      initialLiquidationLTV: c.initialLiquidationLTV,
      targetTimestamp: c.targetTimestamp,
      rampDuration: c.rampDuration,
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

export const getUtilization = (totalAssets: bigint, totalBorrow: bigint): number => {
  if (!totalAssets || totalAssets <= 0n || !totalBorrow || totalBorrow <= 0n) {
    return 0
  }

  const assetsNum = Number(totalAssets)
  const borrowNum = Number(totalBorrow)

  const utilization = (borrowNum / assetsNum) * 100

  return Number(utilization.toFixed(2))
}

export const getVaultUtilization = (vault: Vault | SecuritizeVault): number => {
  return getUtilization(vault.totalAssets, vault.borrow)
}
