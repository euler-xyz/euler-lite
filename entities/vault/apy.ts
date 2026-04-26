import { parseUnits, type Address } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import { SECONDS_IN_YEAR, TARGET_TIME_AGO } from '~/entities/constants'
import { eulerUtilsLensABI, eulerVaultLensABI } from '~/entities/euler/abis'
import { vaultConvertToAssetsAbi } from '~/abis/vault'
import { getPublicClient } from '~/utils/public-client'
import { logConciseFetchError } from './log-fetch-error'

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

interface BlockDataCache {
  oneHourAgoBlock: number
  timeElapsedSeconds: number
}

const SAMPLE_DISTANCE = 10_000

export const fetchBlockDataForAPY = async (rpcUrl: string, chainId: number): Promise<BlockDataCache | null> => {
  try {
    const client = getPublicClient(rpcUrl)
    const currentBlock = Number(await client.getBlockNumber())
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
    logWarn('apy/calculate', e, { severity: 'error' })
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
  return calculateEarnVaultAPYWithCache(vaultAddress, decimals, blockCache, rpcUrl)
}
