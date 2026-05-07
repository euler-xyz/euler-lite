import { maxUint256, type Address } from 'viem'
import type { Vault, SecuritizeVault, EarnVault, BorrowVaultPair } from './types'
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

// What the vault can actually pay out right now in its underlying asset:
// - EVK Vault: only cash on hand (the rest is lent out to borrowers).
// - SecuritizeVault: the whole supply (no borrowing).
// - EarnVault: liquidity reachable across allocated strategies.
const getVaultWithdrawCapacity = (vault: Vault | SecuritizeVault | EarnVault): bigint => {
  if ('type' in vault && vault.type === 'securitize') return vault.totalAssets
  if ('type' in vault && vault.type === 'earn') return vault.availableAssets
  return vault.totalCash
}

export const getCashLimitedWithdrawAmount = (
  userWithdrawableAssets: bigint,
  vault: Vault | SecuritizeVault | EarnVault | undefined,
): bigint => {
  if (!vault) return userWithdrawableAssets
  const capacity = getVaultWithdrawCapacity(vault)
  return userWithdrawableAssets < capacity ? userWithdrawableAssets : capacity
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

const bigintPercentage = (numerator: bigint, denominator: bigint): number => {
  const scale = 10n ** 2n
  const fraction = (numerator * scale * 100n) / denominator
  const whole = fraction / scale
  const remainder = fraction % scale
  return parseFloat(`${whole}.${remainder.toString().padStart(2, '0')}`)
}

export const getSupplyCapPercentage = (vault: Vault): number => {
  if (vault.supplyCap >= maxUint256) return 0
  if (vault.supplyCap === 0n) return vault.supply > 0n ? 100 : 0
  return bigintPercentage(vault.supply, vault.supplyCap)
}

export const getBorrowCapPercentage = (vault: Vault): number => {
  if (vault.borrowCap >= maxUint256) return 0
  if (vault.borrowCap === 0n) return vault.borrow > 0n ? 100 : 0
  return bigintPercentage(vault.borrow, vault.borrowCap)
}
