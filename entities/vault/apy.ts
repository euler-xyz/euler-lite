import { parseUnits, type Address } from 'viem'
import { logger } from '~/utils/logger'
import { SECONDS_IN_YEAR, TARGET_TIME_AGO } from '~/entities/constants'
import { eulerUtilsLensABI, eulerVaultLensABI } from '~/entities/euler/abis'
import { vaultConvertToAssetsAbi } from '~/abis/vault'
import { getPublicClient } from '~/utils/public-client'
import { batchLensCalls } from '~/utils/multicall'
import { logConciseFetchError } from './log-fetch-error'

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
  const { client: rpcClient, rpcUrl } = useRpcClient()
  const { eulerLensAddresses, eulerCoreAddresses } = useEulerAddresses()

  if (!requests.length) {
    return []
  }

  if (!eulerLensAddresses.value?.vaultLens) {
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

  const calls = active.map(item => ({
    functionName: 'getVaultInterestRateModelInfo',
    args: [
      item.request.vaultAddress as Address,
      [item.adjustedCash],
      [item.adjustedBorrows],
    ],
  }))

  if (eulerCoreAddresses.value?.evc && rpcUrl.value) {
    const batchResults = await batchLensCalls<Record<string, unknown>>(
      eulerCoreAddresses.value.evc,
      eulerLensAddresses.value.vaultLens,
      eulerVaultLensABI,
      calls,
      rpcUrl.value,
    )

    active.forEach((item, activeIndex) => {
      if (batchResults[activeIndex]?.success) {
        results[item.index] = parseProjectedRatesResult(batchResults[activeIndex].result as Record<string, unknown> | null)
      }
    })

    return results
  }

  const fallbackResults = await Promise.all(calls.map(async call =>
    rpcClient.value!.readContract({
      address: eulerLensAddresses.value!.vaultLens as Address,
      abi: eulerVaultLensABI,
      functionName: 'getVaultInterestRateModelInfo',
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

export const computeAPYs = (borrowSPY: bigint, cash: bigint, borrows: bigint, interestFee: bigint) => {
  const { client: rpcClient } = useRpcClient()
  const { eulerLensAddresses } = useEulerAddresses()

  if (!eulerLensAddresses.value?.utilsLens) {
    throw new Error('Euler addresses not loaded yet')
  }

  return rpcClient.value!.readContract({
    address: eulerLensAddresses.value.utilsLens as Address,
    abi: eulerUtilsLensABI,
    functionName: 'computeAPYs',
    args: [borrowSPY, cash, borrows, interestFee],
  })
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

interface BlockDataCache {
  oneHourAgoBlock: number
  timeElapsedSeconds: number
}

const SAMPLE_DISTANCE = 10_000

export const fetchBlockDataForAPY = async (rpcUrl: string, chainId: number): Promise<BlockDataCache | null> => {
  try {
    const client = getPublicClient(rpcUrl)
    const currentBlock = Math.max(0, Number(await client.getBlockNumber()) - 1)
    const sampleDistance = Math.min(SAMPLE_DISTANCE, currentBlock)

    if (sampleDistance === 0) {
      return null
    }

    const [currentBlockData, sampleBlockData] = await Promise.all([
      client.getBlock({ blockNumber: BigInt(currentBlock) }),
      client.getBlock({ blockNumber: BigInt(currentBlock - sampleDistance) }),
    ])

    if (!currentBlockData || !sampleBlockData) {
      return null
    }

    const timeDiff = Number(currentBlockData.timestamp - sampleBlockData.timestamp)
    const avgBlockTime = timeDiff / sampleDistance

    if (avgBlockTime <= 0) {
      return null
    }

    const blocksPerHour = Math.round(TARGET_TIME_AGO / avgBlockTime)
    const oneHourAgoBlock = Math.max(0, currentBlock - blocksPerHour)
    const timeElapsedSeconds = blocksPerHour * avgBlockTime

    return { oneHourAgoBlock, timeElapsedSeconds }
  }
  catch (e) {
    logConciseFetchError('apy/fetchBlockData', chainId, 'block data', e)
    return null
  }
}

export const calculateEarnVaultAPYWithCache = async (
  vaultAddress: string,
  decimals: bigint,
  blockCache: BlockDataCache,
  rpcUrl: string,
  chainId: number,
): Promise<number> => {
  try {
    const client = getPublicClient(rpcUrl)

    const oneShare = parseUnits('1', Number(decimals))

    const [currentRate, oneHourAgoRate] = await Promise.all([
      client.readContract({
        address: vaultAddress as Address,
        abi: vaultConvertToAssetsAbi,
        functionName: 'convertToAssets',
        args: [oneShare],
      }) as Promise<bigint>,
      client.readContract({
        address: vaultAddress as Address,
        abi: vaultConvertToAssetsAbi,
        functionName: 'convertToAssets',
        args: [oneShare],
        blockNumber: BigInt(blockCache.oneHourAgoBlock),
      }) as Promise<bigint>,
    ])

    if (oneHourAgoRate === 0n || blockCache.timeElapsedSeconds <= 0) {
      return 0
    }

    const rateChange = Number(currentRate - oneHourAgoRate) / Number(oneHourAgoRate)
    const apy = ((rateChange * SECONDS_IN_YEAR) / blockCache.timeElapsedSeconds) * 100

    return Number.isFinite(apy) ? apy : 0
  }
  catch (e) {
    logger.error({ ctx: 'apy/calculate', chainId, vault: vaultAddress, err: e }, 'failed to calculate APY')
    return 0
  }
}

// Legacy function for single vault fetch (kept for backward compatibility)
export const calculateEarnVaultAPYFromExchangeRate = async (
  vaultAddress: string,
  decimals: bigint,
  rpcUrl: string,
  chainId: number,
): Promise<number> => {
  const blockCache = await fetchBlockDataForAPY(rpcUrl, chainId)
  if (!blockCache) {
    return 0
  }
  return calculateEarnVaultAPYWithCache(vaultAddress, decimals, blockCache, rpcUrl, chainId)
}
