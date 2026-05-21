import type { Address } from 'viem'
import { logger } from '~/utils/logger'
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
  measurementBlock: number
  measurementTimestamp: bigint
  priorBlock: number
  priorTimestamp: bigint
}

const SAMPLE_DISTANCE = 10_000

// Blocks to step back from the latest head when picking the "current" sample
// point. Load-balanced JSON-RPC fleets can serve subsequent eth_calls from
// nodes whose heads lag the node that answered `getBlockNumber()` by 1–2
// blocks; pinning convertToAssets to `latest.number` would then fail on lagging
// nodes. Backing off by a few blocks puts the measurement at a height that
// every plausibly-synced backend has seen, while the resulting staleness
// (~60s on Ethereum, sub-second on most L2s) is negligible against the 3600s
// measurement window.
const MEASUREMENT_BLOCK_BACKOFF = 5

// Extra digits of precision added on top of share decimals when probing the
// vault exchange rate. The probe is linear in `convertToAssets`, so scaling it
// up costs nothing other than headroom against uint256 overflow. With 1e12 on
// top of asset decimals, even low-decimal assets (USDC/cbBTC) keep tens of
// significant digits of resolution in the 1h rate change.
const PROBE_PRECISION_BOOST = 12n

// Compound a measured rate change observed over `elapsedSeconds` into an APY,
// using continuous-per-second compounding to match the EVK/Lens convention.
// Equivalent to `(1 + spy) ** SECONDS_IN_YEAR - 1` where `spy = rateChange / elapsedSeconds`.
// Exported for unit testing.
export const computeApyFromRateChange = (
  currentRate: bigint,
  priorRate: bigint,
  elapsedSeconds: number,
): number => {
  if (priorRate === 0n || elapsedSeconds <= 0) {
    return 0
  }
  const rateChange = Number(currentRate - priorRate) / Number(priorRate)
  const spy = rateChange / elapsedSeconds
  const apy = (Math.pow(1 + spy, SECONDS_IN_YEAR) - 1) * 100
  return Number.isFinite(apy) ? apy : 0
}

export const fetchBlockDataForAPY = async (rpcUrl: string, chainId: number): Promise<BlockDataCache | null> => {
  try {
    const client = getPublicClient(rpcUrl)

    // Pick a recent block from any node, then back off so the result is one
    // that every plausibly-synced backend has seen. Both the rate and the
    // timestamp will be pinned to this height, so atomicity is preserved by
    // historical-block determinism rather than by bundling reads.
    const latestBlockNumber = Number(await client.getBlockNumber())
    const measurementBlock = latestBlockNumber - MEASUREMENT_BLOCK_BACKOFF
    if (measurementBlock < 1) {
      return null
    }

    const sampleDistance = Math.min(SAMPLE_DISTANCE, measurementBlock)
    if (sampleDistance === 0) {
      return null
    }

    // Fetch the measurement block (gives currentTimestamp + acts as the upper
    // sample point) and the older sample block in parallel.
    const [measurementBlockData, sampleBlockData] = await Promise.all([
      client.getBlock({ blockNumber: BigInt(measurementBlock) }),
      client.getBlock({ blockNumber: BigInt(measurementBlock - sampleDistance) }),
    ])

    if (!measurementBlockData || !sampleBlockData) {
      return null
    }

    const avgBlockTime = Number(measurementBlockData.timestamp - sampleBlockData.timestamp) / sampleDistance
    if (avgBlockTime <= 0) {
      return null
    }

    const blocksPerHour = Math.round(TARGET_TIME_AGO / avgBlockTime)
    const priorBlock = measurementBlock - blocksPerHour

    // Bail if the chain has less than ~1h of history rather than silently
    // clamping to genesis — the latter would normalise the rate change against
    // a too-short window and explode the displayed APY.
    if (priorBlock < 1) {
      return null
    }

    // Read the actual timestamp at the prior block instead of trusting the
    // 10K-block average. Block-rate variance over the last hour (sequencer
    // hiccups, MEV bursts, late-block stretches) would otherwise scale the
    // displayed APY by the inverse of the rate skew.
    const priorBlockData = await client.getBlock({ blockNumber: BigInt(priorBlock) })
    if (!priorBlockData) {
      return null
    }

    return {
      measurementBlock,
      measurementTimestamp: measurementBlockData.timestamp,
      priorBlock,
      priorTimestamp: priorBlockData.timestamp,
    }
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

    const probeShares = 10n ** (decimals + PROBE_PRECISION_BOOST)

    // Both reads target fixed historical blocks, so any synced node returns
    // the same data and the two reads pair correctly with the cache's
    // pre-fetched timestamps even when served by different RPC backends.
    const [currentRate, priorRate] = await Promise.all([
      client.readContract({
        address: vaultAddress as Address,
        abi: vaultConvertToAssetsAbi,
        functionName: 'convertToAssets',
        args: [probeShares],
        blockNumber: BigInt(blockCache.measurementBlock),
      }) as Promise<bigint>,
      client.readContract({
        address: vaultAddress as Address,
        abi: vaultConvertToAssetsAbi,
        functionName: 'convertToAssets',
        args: [probeShares],
        blockNumber: BigInt(blockCache.priorBlock),
      }) as Promise<bigint>,
    ])

    const timeElapsedSeconds = Number(blockCache.measurementTimestamp - blockCache.priorTimestamp)
    return computeApyFromRateChange(currentRate, priorRate, timeElapsedSeconds)
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
