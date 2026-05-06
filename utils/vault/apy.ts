import type { Address } from 'viem'
import { eulerVaultLensABI } from '~/entities/euler/abis'

export interface ProjectedRates {
  supplyAPY: bigint // 27 decimals
  borrowAPY: bigint // 27 decimals
}

export const getProjectedRates = async (
  vaultAddress: string,
  currentCash: bigint,
  currentBorrows: bigint,
  cashDelta: bigint,
  borrowsDelta: bigint,
): Promise<ProjectedRates | null> => {
  const { client: rpcClient } = useRpcClient()
  const { eulerLensAddresses } = useEulerAddresses()

  if (!eulerLensAddresses.value?.vaultLens) {
    return null
  }

  const adjustedCash = currentCash + cashDelta < 0n ? 0n : currentCash + cashDelta
  const adjustedBorrows = currentBorrows + borrowsDelta < 0n ? 0n : currentBorrows + borrowsDelta

  if (adjustedCash === 0n && adjustedBorrows === 0n) {
    return { supplyAPY: 0n, borrowAPY: 0n }
  }

  const result = await rpcClient.value!.readContract({
    address: eulerLensAddresses.value.vaultLens as Address,
    abi: eulerVaultLensABI,
    functionName: 'getVaultInterestRateModelInfo',
    args: [vaultAddress as Address, [adjustedCash], [adjustedBorrows]],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic lens contract return
  }) as Record<string, any>

  if (result.queryFailure || !result.interestRateInfo?.length) {
    return null
  }

  const info = result.interestRateInfo[0]
  return {
    supplyAPY: info.supplyAPY as bigint,
    borrowAPY: info.borrowAPY as bigint,
  }
}

export const getNetAPY = (
  supplyUSD: number,
  supplyAPY: number,
  borrowUSD: number,
  borrowAPY: number,
  supplyRewardAPY?: number | null,
  borrowRewardAPY?: number | null,
  loopingRewardAPY?: number | null,
) => {
  if (supplyUSD === 0) {
    return 0
  }
  const equity = supplyUSD - borrowUSD
  const sum
    = supplyUSD * (supplyAPY + (supplyRewardAPY || 0))
      - borrowUSD * (borrowAPY - (borrowRewardAPY || 0))
      + equity * (loopingRewardAPY || 0)
  return sum / supplyUSD
}

export const getRoe = (
  supplyUSD: number,
  supplyAPY: number,
  borrowUSD: number,
  borrowAPY: number,
  supplyRewardAPY?: number | null,
  borrowRewardAPY?: number | null,
  loopingRewardAPY?: number | null,
) => {
  const equity = supplyUSD - borrowUSD
  if (equity <= 0) return 0
  const netYield
    = supplyUSD * (supplyAPY + (supplyRewardAPY || 0))
      - borrowUSD * (borrowAPY - (borrowRewardAPY || 0))
      + equity * (loopingRewardAPY || 0)
  return netYield / equity
}
