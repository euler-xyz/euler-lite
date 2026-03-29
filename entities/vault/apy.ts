import { parseUnits, type Address } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import { SECONDS_IN_YEAR, TARGET_TIME_AGO } from '~/entities/constants'
import { eulerUtilsLensABI, eulerVaultLensABI } from '~/entities/euler/abis'
import { vaultConvertToAssetsAbi } from '~/abis/vault'

export interface ProjectedRates {
  supplyAPY: bigint // 27 decimals
  borrowAPY: bigint // 27 decimals
}

const ZERO_RATES: ProjectedRates = { supplyAPY: 0n, borrowAPY: 0n }

export const getProjectedRates = async (
  vaultAddress: string,
  currentCash: bigint,
  currentBorrows: bigint,
  cashDelta: bigint,
  borrowsDelta: bigint,
): Promise<ProjectedRates> => {
  const { client: rpcClient } = useRpcClient()
  const { eulerLensAddresses } = useEulerAddresses()

  if (!eulerLensAddresses.value?.vaultLens) {
    return ZERO_RATES
  }

  const adjustedCash = currentCash + cashDelta < 0n ? 0n : currentCash + cashDelta
  const adjustedBorrows = currentBorrows + borrowsDelta < 0n ? 0n : currentBorrows + borrowsDelta

  if (adjustedCash === 0n && adjustedBorrows === 0n) {
    return ZERO_RATES
  }

  const result = await rpcClient.value!.readContract({
    address: eulerLensAddresses.value.vaultLens as Address,
    abi: eulerVaultLensABI,
    functionName: 'getVaultInterestRateModelInfo',
    args: [vaultAddress as Address, [adjustedCash], [adjustedBorrows]],
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- dynamic lens contract return
  }) as Record<string, any>

  if (result.queryFailure || !result.interestRateInfo?.length) {
    return ZERO_RATES
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

// Cached block data for APY calculations (shared across all vaults)
interface BlockDataCache {
  currentBlock: number
  currentBlockData: { number: bigint, timestamp: bigint }
  oneHourAgoBlock: number
  oneHourAgoBlockData: { number: bigint, timestamp: bigint }
}

// Pre-fetch block data once for all APY calculations
export const fetchBlockDataForAPY = async (): Promise<BlockDataCache | null> => {
  try {
    const { client: rpcClient } = useRpcClient()
    const client = rpcClient.value!
    const currentBlockBigInt = await client.getBlockNumber()
    const currentBlock = Number(currentBlockBigInt)
    const sampleDistance = 100

    // Estimate oneHourAgoBlock upfront using typical block times
    // This allows all 3 getBlock calls to run in parallel
    // We'll refine the estimate after getting actual block data
    const estimatedBlockTime = 12 // Conservative estimate (Ethereum mainnet)
    const estimatedBlocksPerHour = Math.floor(TARGET_TIME_AGO / estimatedBlockTime)
    const estimatedOneHourAgoBlock = Math.max(0, currentBlock - estimatedBlocksPerHour)

    // Fetch all 3 blocks in parallel
    const [currentBlockData, sampleBlockData, estimatedOneHourAgoBlockData] = await Promise.all([
      client.getBlock({ blockNumber: BigInt(currentBlock) }),
      client.getBlock({ blockNumber: BigInt(currentBlock - sampleDistance) }),
      client.getBlock({ blockNumber: BigInt(estimatedOneHourAgoBlock) }),
    ])

    if (!currentBlockData || !sampleBlockData) {
      return null
    }

    // Calculate actual block time and refine if needed
    const timeDiff = Number(currentBlockData.timestamp - sampleBlockData.timestamp)
    const avgBlockTime = timeDiff / sampleDistance

    if (avgBlockTime === 0) {
      return null
    }

    const blocksPerHour = Math.floor(TARGET_TIME_AGO / avgBlockTime)
    const actualOneHourAgoBlock = Math.max(0, currentBlock - blocksPerHour)

    // If estimate was close enough, use the already-fetched block data
    // Otherwise fetch the correct block (rare case)
    let oneHourAgoBlockData = estimatedOneHourAgoBlockData
    if (actualOneHourAgoBlock !== estimatedOneHourAgoBlock) {
      oneHourAgoBlockData = await client.getBlock({ blockNumber: BigInt(actualOneHourAgoBlock) })
    }

    if (!oneHourAgoBlockData) {
      return null
    }

    return {
      currentBlock,
      currentBlockData,
      oneHourAgoBlock: actualOneHourAgoBlock,
      oneHourAgoBlockData,
    }
  }
  catch (e) {
    logWarn('apy/fetchBlockData', e, { severity: 'error' })
    return null
  }
}

// Calculate APY using cached block data (only 2 RPC calls per vault instead of 6)
export const calculateEarnVaultAPYWithCache = async (
  vaultAddress: string,
  decimals: bigint,
  blockCache: BlockDataCache,
): Promise<number> => {
  try {
    const { client: rpcClient } = useRpcClient()
    const client = rpcClient.value!

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

    if (oneHourAgoRate === 0n) {
      return 0
    }

    const timeElapsed = Number(blockCache.currentBlockData.timestamp - blockCache.oneHourAgoBlockData.timestamp)

    if (timeElapsed === 0) {
      return 0
    }

    const rateChange = Number(currentRate - oneHourAgoRate) / Number(oneHourAgoRate)
    const apy = ((rateChange * SECONDS_IN_YEAR) / timeElapsed) * 100

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
): Promise<number> => {
  const blockCache = await fetchBlockDataForAPY()
  if (!blockCache) {
    return 0
  }
  return calculateEarnVaultAPYWithCache(vaultAddress, decimals, blockCache)
}
