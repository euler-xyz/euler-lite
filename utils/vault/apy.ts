import type { Address, PublicClient } from 'viem'
import { eulerVaultLensABI } from '~/entities/euler/abis'
import { getEulerSdk } from '~/composables/useEulerSdk'
import { batchLensCalls } from '~/utils/multicall'

export interface ProjectedRates {
  supplyAPY: bigint // 27 decimals
  borrowAPY: bigint // 27 decimals
}

export interface ProjectedRatesRequest {
  vaultAddress: string
  currentCash: bigint
  currentBorrows: bigint
  cashDelta: bigint
  borrowsDelta: bigint
}

const toAdjustedRateState = (request: ProjectedRatesRequest) => {
  const adjustedCash = request.currentCash + request.cashDelta < 0n ? 0n : request.currentCash + request.cashDelta
  const adjustedBorrows = request.currentBorrows + request.borrowsDelta < 0n ? 0n : request.currentBorrows + request.borrowsDelta

  return { adjustedCash, adjustedBorrows }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic lens contract return
const parseProjectedRatesResult = (result: Record<string, any> | null): ProjectedRates | null => {
  if (!result || result.queryFailure || !result.interestRateInfo?.length) {
    return null
  }

  const info = result.interestRateInfo[0]
  return {
    supplyAPY: info.supplyAPY as bigint,
    borrowAPY: info.borrowAPY as bigint,
  }
}

export const getProjectedRatesBatch = async (
  requests: ProjectedRatesRequest[],
): Promise<Array<ProjectedRates | null>> => {
  const { chainId, eulerLensAddresses, eulerCoreAddresses } = useEulerAddresses()

  if (!requests.length) {
    return []
  }

  if (!eulerLensAddresses.value?.vaultLens || !chainId.value) {
    return requests.map(() => null)
  }

  const prepared = requests.map((request) => {
    const { adjustedCash, adjustedBorrows } = toAdjustedRateState(request)
    return {
      request,
      adjustedCash,
      adjustedBorrows,
      isEmpty: adjustedCash === 0n && adjustedBorrows === 0n,
    }
  })

  const results: Array<ProjectedRates | null> = prepared.map(item =>
    item.isEmpty ? { supplyAPY: 0n, borrowAPY: 0n } : null,
  )
  const active = prepared
    .map((item, index) => ({ ...item, index }))
    .filter(item => !item.isEmpty)

  if (!active.length) {
    return results
  }

  const sdk = await getEulerSdk()
  // The SDK is linked from a workspace and ships its own viem (2.43.x), so
  // its PublicClient is structurally similar but not identical to the app's
  // viem (2.48.x) — cast once at the boundary.
  const provider = sdk.providerService.getProvider(chainId.value) as unknown as PublicClient

  const calls = active.map(item => ({
    functionName: 'getVaultInterestRateModelInfo',
    args: [
      item.request.vaultAddress as Address,
      [item.adjustedCash],
      [item.adjustedBorrows],
    ],
  }))

  if (eulerCoreAddresses.value?.evc) {
    const batchResults = await batchLensCalls<Record<string, unknown>>(
      provider,
      eulerCoreAddresses.value.evc,
      eulerLensAddresses.value.vaultLens,
      eulerVaultLensABI,
      calls,
    )

    active.forEach((item, activeIndex) => {
      if (batchResults[activeIndex]?.success) {
        results[item.index] = parseProjectedRatesResult(batchResults[activeIndex].result as Record<string, unknown> | null)
      }
    })

    return results
  }

  const fallbackResults = await Promise.all(calls.map(async call =>
    provider.readContract({
      address: eulerLensAddresses.value!.vaultLens as Address,
      abi: eulerVaultLensABI,
      functionName: 'getVaultInterestRateModelInfo',
      authorizationList: undefined,
      args: call.args as [Address, bigint[], bigint[]],
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic lens contract return
    }) as Promise<Record<string, any>>,
  ))

  active.forEach((item, activeIndex) => {
    results[item.index] = parseProjectedRatesResult(fallbackResults[activeIndex])
  })

  return results
}

export const getProjectedRates = async (
  vaultAddress: string,
  currentCash: bigint,
  currentBorrows: bigint,
  cashDelta: bigint,
  borrowsDelta: bigint,
): Promise<ProjectedRates | null> => {
  const [result] = await getProjectedRatesBatch([{
    vaultAddress,
    currentCash,
    currentBorrows,
    cashDelta,
    borrowsDelta,
  }])
  return result
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

interface WeightedSupplySnapshot {
  supplyUsd: number
  weightedSupplyApy: number | null
}

export const getNetAPYFromWeightedSupplySnapshot = (
  snapshot: WeightedSupplySnapshot,
  fallbackSupplyAPY: number,
  borrowUSD: number,
  borrowAPY: number,
  fallbackSupplyRewardAPY?: number | null,
  borrowRewardAPY?: number | null,
  loopingRewardAPY?: number | null,
) => getNetAPY(
  snapshot.supplyUsd,
  snapshot.weightedSupplyApy ?? fallbackSupplyAPY,
  borrowUSD,
  borrowAPY,
  snapshot.weightedSupplyApy === null ? fallbackSupplyRewardAPY : null,
  borrowRewardAPY,
  loopingRewardAPY,
)

export function getRoe(
  supplyUSD: number,
  supplyAPY: number,
  borrowUSD: number,
  borrowAPY: number,
  supplyRewardAPY?: number | null,
  borrowRewardAPY?: number | null,
  loopingRewardAPY?: number | null,
): number
export function getRoe(
  supplyUSD: number | null,
  supplyAPY: number | null,
  borrowUSD: number | null,
  borrowAPY: number | null,
  supplyRewardAPY?: number | null,
  borrowRewardAPY?: number | null,
  loopingRewardAPY?: number | null,
): number | null
export function getRoe(
  supplyUSD: number | null,
  supplyAPY: number | null,
  borrowUSD: number | null,
  borrowAPY: number | null,
  supplyRewardAPY?: number | null,
  borrowRewardAPY?: number | null,
  loopingRewardAPY?: number | null,
) {
  if (supplyUSD === null || borrowUSD === null || supplyAPY === null || borrowAPY === null) {
    return null
  }
  const equity = supplyUSD - borrowUSD
  if (!Number.isFinite(equity)) return null
  if (equity <= 0) return 0
  const netYield
    = supplyUSD * (supplyAPY + (supplyRewardAPY || 0))
      - borrowUSD * (borrowAPY - (borrowRewardAPY || 0))
      + equity * (loopingRewardAPY || 0)
  if (!Number.isFinite(netYield)) {
    return null
  }
  return netYield / equity
}
