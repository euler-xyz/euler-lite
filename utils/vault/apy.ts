import type { Address, PublicClient } from 'viem'
import { eulerVaultLensABI } from '~/entities/euler/abis'
import { getEulerSdk } from '~/composables/useEulerSdk'

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
  const { chainId, eulerLensAddresses } = useEulerAddresses()

  if (!eulerLensAddresses.value?.vaultLens || !chainId.value) {
    return null
  }

  const adjustedCash = currentCash + cashDelta < 0n ? 0n : currentCash + cashDelta
  const adjustedBorrows = currentBorrows + borrowsDelta < 0n ? 0n : currentBorrows + borrowsDelta

  if (adjustedCash === 0n && adjustedBorrows === 0n) {
    return { supplyAPY: 0n, borrowAPY: 0n }
  }

  const sdk = await getEulerSdk()
  // The SDK is linked from a workspace and ships its own viem (2.43.x), so
  // its PublicClient is structurally similar but not identical to the app's
  // viem (2.48.x) — cast once at the boundary.
  const provider = sdk.providerService.getProvider(chainId.value) as unknown as PublicClient

  const result = await provider.readContract({
    address: eulerLensAddresses.value.vaultLens as Address,
    abi: eulerVaultLensABI,
    functionName: 'getVaultInterestRateModelInfo',
    authorizationList: undefined,
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
