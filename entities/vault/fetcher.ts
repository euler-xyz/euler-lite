import { getAddress, zeroAddress, type Address } from 'viem'
import type {
  Vault,
  SecuritizeVault,
  EarnVault,
  EarnVaultStrategyInfo,
  VaultIteratorResult,
} from './types'
import { resolveAssetPriceInfo, resolveUnitOfAccountPriceInfo } from './pricing'
import { calculateEarnVaultAPYFromExchangeRate, calculateEarnVaultAPYWithCache, fetchBlockDataForAPY } from './apy'
import { logger } from '~/utils/logger'
import { summarizeViemError } from '~/utils/viem-errors'
import { BATCH_SIZE_PARALLEL_ROUNDS, getVaultFetchBatchSize } from '~/entities/tuning-constants'
import type { PythFeed } from '~/entities/oracle'
import { collectPythFeedIds } from '~/entities/oracle'
import {
  eulerEarnVaultLensABI,
  eulerUtilsLensABI,
  eulerVaultLensABI,
} from '~/entities/euler/abis'
import { executeLensWithPythSimulation, executeBatchLensWithPythSimulation } from '~/utils/pyth'
import { valueToNano } from '~/utils/crypto-utils'
import { batchLensCalls } from '~/utils/multicall'
import { getPublicClient } from '~/utils/public-client'
import { logConciseFetchError } from './log-fetch-error'

/**
 * Context bundle the pure fetchers need. Both the client-side composable
 * wrappers and the server-side loader build this from their own sources
 * (composables vs the chain-config plugin) and pass it in.
 */
export interface FetchVaultContext {
  chainId: number
  rpcUrl: string
  lensAddresses: {
    vaultLens: string
    eulerEarnVaultLens: string
    utilsLens: string
  }
  coreAddresses?: { evc?: string }
  peripheryAddresses?: { escrowedCollateralPerspective?: string }
  pythHermesUrl?: string
  verifiedVaultAddresses: string[]
  earnVaultAddresses: string[]
  /** Optional abort signal. Checked between parallel rounds in generators. */
  isAborted?: () => boolean
}

interface ProcessVaultOptions {
  verified?: boolean
  vaultCategory?: string
}

/**
 * Process raw vault lens data into a Vault object.
 * Shared by all vault fetchers — single source of truth for raw → Vault mapping.
 */

export const processRawVaultData = (
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw lens data with dynamic shape
  raw: any,
  vaultAddress: string,
  verifiedVaultAddresses?: string[],
  options?: ProcessVaultOptions,
): Vault => {
  const verified = verifiedVaultAddresses?.includes(vaultAddress) ?? options?.verified ?? false
  return {
    verified,
    ...(options?.vaultCategory ? { vaultCategory: options.vaultCategory } : {}),
    address: raw.vault,
    name: raw.vaultName,
    supply: raw.totalAssets,
    borrow: raw.totalBorrowed,
    symbol: raw.vaultSymbol,
    decimals: raw.vaultDecimals,
    supplyCap: raw.supplyCap,
    borrowCap: raw.borrowCap,
    totalCash: raw.totalCash,
    totalAssets: raw.totalAssets,
    totalShares: raw.totalShares,
    interestFee: raw.interestFee,
    configFlags: raw.configFlags,
    oracle: raw.oracle,
    collateralLTVs: raw.collateralLTVInfo,
    collateralPrices: raw.collateralPriceInfo,
    liabilityPriceInfo: raw.liabilityPriceInfo,
    maxLiquidationDiscount: raw.maxLiquidationDiscount,
    interestRateInfo: raw.irmInfo?.interestRateInfo?.[0] ?? {
      borrowAPY: 0n,
      borrowSPY: 0n,
      borrows: 0n,
      cash: 0n,
      supplyAPY: 0n,
    },
    asset: {
      address: raw.asset,
      name: raw.assetName,
      symbol: raw.assetSymbol,
      decimals: raw.assetDecimals,
    },
    oracleDetailedInfo: raw.oracleInfo,
    backupAssetOracleInfo: raw.backupAssetOracleInfo,
    dToken: raw.dToken,
    governorAdmin: raw.governorAdmin,
    governorFeeReceiver: raw.governorFeeReceiver,
    unitOfAccount: raw.unitOfAccount,
    unitOfAccountName: raw.unitOfAccountName,
    unitOfAccountSymbol: raw.unitOfAccountSymbol,
    unitOfAccountDecimals: raw.unitOfAccountDecimals,
    interestRateModelAddress: raw.interestRateModel,
    hookTarget: getAddress(raw.hookTarget),
    hookedOps: raw.hookedOperations ?? 0n,
    irmInfo: raw.irmInfo
      ? {
          interestRateModelInfo: raw.irmInfo.interestRateModelInfo,
        }
      : undefined,
  } as Vault
}

/**
 * Fetch vault using EVC batchSimulation with Pyth updates.
 * This ensures fresh Pyth prices are available when querying vault info.
 */
const fetchVaultWithPythSimulation = async (
  vaultAddress: string,
  feeds: PythFeed[],
  rpcUrl: string,
  vaultLensAddress: string,
  evcAddress: string,
  hermesEndpoint: string,
  verifiedVaultAddresses: string[],
): Promise<Vault | undefined> => {
  const result = await executeLensWithPythSimulation(
    feeds,
    vaultLensAddress as Address,
    eulerVaultLensABI,
    'getVaultInfoFull',
    [vaultAddress],
    evcAddress,
    rpcUrl,
    hermesEndpoint,
  ) as Record<string, unknown> | undefined

  if (!result) {
    return undefined
  }

  return processRawVaultData(result, vaultAddress, verifiedVaultAddresses)
}

export const fetchVault = async (vaultAddress: string, ctx: FetchVaultContext): Promise<Vault> => {
  const client = getPublicClient(ctx.rpcUrl)

  // Standard query first (fast path for non-Pyth vaults)
  const raw = await client.readContract({
    address: ctx.lensAddresses.vaultLens as Address,
    abi: eulerVaultLensABI,
    functionName: 'getVaultInfoFull',
    args: [vaultAddress],
  }) as Record<string, unknown>
  let vault = processRawVaultData(raw, vaultAddress, ctx.verifiedVaultAddresses)

  // Check if vault uses Pyth oracles
  const feeds = collectPythFeedIds(vault.oracleDetailedInfo)

  // ALWAYS re-query with simulation if Pyth detected
  // Pyth prices are only valid for ~2 minutes after on-chain update,
  // so we need fresh prices even if current query succeeded
  if (feeds.length > 0 && ctx.coreAddresses?.evc && ctx.pythHermesUrl) {
    const vaultWithFreshPrice = await fetchVaultWithPythSimulation(
      vaultAddress,
      feeds,
      ctx.rpcUrl,
      ctx.lensAddresses.vaultLens,
      ctx.coreAddresses.evc,
      ctx.pythHermesUrl,
      ctx.verifiedVaultAddresses,
    )
    if (vaultWithFreshPrice) {
      vault = vaultWithFreshPrice
    }
  }

  const [assetPriceInfo, unitOfAccountPriceInfo] = await Promise.all([
    resolveAssetPriceInfo(ctx.rpcUrl, ctx.lensAddresses.utilsLens, vault.asset.address),
    resolveUnitOfAccountPriceInfo(ctx.rpcUrl, ctx.lensAddresses.utilsLens, vault.unitOfAccount),
  ])
  vault = { ...vault, assetPriceInfo, unitOfAccountPriceInfo }

  return vault
}

export const fetchSecuritizeVault = async (
  vaultAddress: string,
  ctx: FetchVaultContext,
): Promise<SecuritizeVault> => {
  const client = getPublicClient(ctx.rpcUrl)

  const data = await client.readContract({
    address: ctx.lensAddresses.utilsLens as Address,
    abi: eulerUtilsLensABI,
    functionName: 'getVaultInfoERC4626',
    args: [vaultAddress as Address],
  }) as Record<string, unknown>

  const governorAdminAbi = [
    {
      inputs: [],
      name: 'governorAdmin',
      outputs: [{ internalType: 'address', name: '', type: 'address' }],
      stateMutability: 'view',
      type: 'function',
    },
  ] as const

  const supplyCapResolvedAbi = [
    {
      inputs: [],
      name: 'supplyCapResolved',
      outputs: [{ internalType: 'uint256', name: '', type: 'uint256' }],
      stateMutability: 'view',
      type: 'function',
    },
  ] as const

  let governorAdmin: string = zeroAddress
  let supplyCap = 0n
  try {
    governorAdmin = await client.readContract({
      address: vaultAddress as Address,
      abi: governorAdminAbi,
      functionName: 'governorAdmin',
    }) as string
  }
  catch {
    // governorAdmin may not exist on all vaults
  }
  try {
    supplyCap = await client.readContract({
      address: vaultAddress as Address,
      abi: supplyCapResolvedAbi,
      functionName: 'supplyCapResolved',
    }) as bigint
  }
  catch {
    // supplyCapResolved may not exist on all vaults
  }

  const assetPriceInfo = await resolveAssetPriceInfo(
    ctx.rpcUrl,
    ctx.lensAddresses.utilsLens,
    data.asset as string,
  )

  return {
    type: 'securitize',
    verified: ctx.verifiedVaultAddresses.includes(vaultAddress),
    address: data.vault,
    name: data.vaultName,
    symbol: data.vaultSymbol,
    decimals: data.vaultDecimals,
    totalShares: data.totalShares,
    totalAssets: data.totalAssets,
    isEVault: data.isEVault,
    asset: {
      address: data.asset,
      name: data.assetName,
      symbol: data.assetSymbol,
      decimals: data.assetDecimals,
    },
    governorAdmin,
    supplyCap,
    // Compatibility fields with Vault type
    supply: data.totalAssets, // Same as totalAssets
    borrow: 0n, // Securitize vaults can't be borrowed from
    interestRateInfo: {
      borrowAPY: 0n,
      borrowSPY: 0n,
      borrows: 0n,
      cash: data.totalAssets,
      supplyAPY: 0n,
    },
    assetPriceInfo,
  } as SecuritizeVault
}

export const fetchEarnVault = async (
  vaultAddress: string,
  ctx: FetchVaultContext,
): Promise<EarnVault> => {
  const client = getPublicClient(ctx.rpcUrl)

  const data = await client.readContract({
    address: ctx.lensAddresses.eulerEarnVaultLens as Address,
    abi: eulerEarnVaultLensABI,
    functionName: 'getVaultInfoFull',
    args: [vaultAddress],
  }) as Record<string, unknown>

  const strategies = (data.strategies as EarnVaultStrategyInfo[]).map((strategy) => {
    return {
      strategy: strategy.strategy,
      allocatedAssets: strategy.allocatedAssets,
      availableAssets: strategy.availableAssets,
      currentAllocationCap: strategy.currentAllocationCap,
      pendingAllocationCap: strategy.pendingAllocationCap,
      pendingAllocationCapValidAt: strategy.pendingAllocationCapValidAt,
      removableAt: strategy.removableAt,
      info: strategy.info,
    }
  })

  const supplyAPYNumber = await calculateEarnVaultAPYFromExchangeRate(
    vaultAddress,
    data.vaultDecimals as bigint,
    ctx.rpcUrl,
    ctx.chainId,
  )

  const assetPriceInfo = await resolveAssetPriceInfo(
    ctx.rpcUrl,
    ctx.lensAddresses.utilsLens,
    data.asset as string,
  )

  const verified = ctx.earnVaultAddresses.includes(vaultAddress)

  return {
    verified,
    type: 'earn',
    address: data.vault,
    name: data.vaultName,
    symbol: data.vaultSymbol,
    decimals: data.vaultDecimals,
    totalShares: data.totalShares,
    totalAssets: data.totalAssets,
    lostAssets: data.lostAssets,
    availableAssets: data.availableAssets,
    timelock: data.timelock,
    performanceFee: data.performanceFee,
    feeReceiver: data.feeReceiver,
    owner: data.owner,
    creator: data.creator,
    curator: data.curator,
    guardian: data.guardian,
    evc: data.evc,
    permit2: data.permit2,
    pendingTimelock: data.pendingTimelock,
    pendingTimelockValidAt: data.pendingTimelockValidAt,
    pendingGuardian: data.pendingGuardian,
    pendingGuardianValidAt: data.pendingGuardianValidAt,
    supplyQueue: data.supplyQueue,
    asset: {
      address: data.asset,
      name: data.assetName,
      symbol: data.assetSymbol,
      decimals: data.assetDecimals,
    },
    strategies,
    interestRateInfo: {
      borrowAPY: 0n,
      borrowSPY: 0n,
      borrows: 0n,
      cash: data.totalAssets as bigint,
      supplyAPY: valueToNano(supplyAPYNumber, 25),
    },
    assetPriceInfo,
  } as EarnVault
}

export const fetchVaults = async function* (
  ctx: FetchVaultContext,
  vaultAddresses?: string[],
): AsyncGenerator<
  VaultIteratorResult<Vault>,
  void,
  unknown
> {
  const client = getPublicClient(ctx.rpcUrl)

  // Use provided addresses if available, otherwise fall back to verifiedVaultAddresses
  // (pre-categorization by caller is preferred to eliminate per-vault RPC calls)
  const verifiedVaults = vaultAddresses || ctx.verifiedVaultAddresses
  const batchSize = getVaultFetchBatchSize(ctx.chainId)
  const parallelBatches = BATCH_SIZE_PARALLEL_ROUNDS

  const batchCount = Math.ceil(verifiedVaults.length / batchSize)
  const parallelRounds = Math.ceil(batchCount / parallelBatches)

  // Helper to process raw vault data into Vault object (delegates to shared function)
  // Uses verifiedVaultAddresses to correctly set the `verified` flag — avoids
  // marking dynamically-resolved vaults (e.g. from user positions) as verified
  // when they get swept into refreshVaults().
  const processVaultResult = (raw: Record<string, unknown>, vaultAddress: string): Vault | undefined => {
    try {
      return processRawVaultData(raw, vaultAddress, ctx.verifiedVaultAddresses)
    }
    catch (e) {
      logger.error({ ctx: 'vault/processResult', chainId: ctx.chainId, err: e }, 'failed to decode vault result')
      return undefined
    }
  }

  // Helper to fetch vault individually (used as fallback)
  const fetchVaultIndividually = async (vaultAddress: string): Promise<Vault | undefined> => {
    try {
      const raw = await client.readContract({
        address: ctx.lensAddresses.vaultLens as Address,
        abi: eulerVaultLensABI,
        functionName: 'getVaultInfoFull',
        args: [vaultAddress],
      }) as Record<string, unknown>
      return processVaultResult(raw, vaultAddress)
    }
    catch (e) {
      logConciseFetchError('vault/fetchIndividual', ctx.chainId, vaultAddress, e)
      return undefined
    }
  }

  // Helper to fetch a batch of vaults using EVC batchSimulation
  const fetchBatch = async (batchAddresses: string[]): Promise<Vault[]> => {
    // Use EVC batchSimulation if available for batched RPC calls
    if (ctx.coreAddresses?.evc) {
      const calls = batchAddresses.map(vaultAddress => ({
        functionName: 'getVaultInfoFull',
        args: [vaultAddress],
      }))

      const results = await batchLensCalls<Record<string, unknown>>(
        ctx.coreAddresses.evc,
        ctx.lensAddresses.vaultLens,
        eulerVaultLensABI,
        calls,
        ctx.rpcUrl,
        batchSize,
      )

      const vaults: Vault[] = []
      const failedAddresses: string[] = []
      let hasTransportError = false

      for (let i = 0; i < results.length; i++) {
        const result = results[i]
        if (result.transportError) {
          hasTransportError = true
        }
        else if (result.success && result.result) {
          // batchLensCalls returns decoded result directly (viem unwraps single outputs)
          const raw = result.result as Record<string, unknown>
          const vault = processVaultResult(raw, batchAddresses[i])
          if (vault) {
            vaults.push(vault)
          }
          else {
            failedAddresses.push(batchAddresses[i])
          }
        }
        else {
          failedAddresses.push(batchAddresses[i])
        }
      }

      // Only retry individually for on-chain reverts, not transport errors (403, network failures).
      // When a transport error is detected we emit ONE batch-level roll-up and skip the per-item
      // retries entirely — this prevents a single upstream RPC outage from producing one log line
      // per vault in the batch (was the root cause of the 568-line BetterStack incident).
      if (failedAddresses.length > 0 && !hasTransportError) {
        logger.warn(
          { ctx: 'vault/fetchBatch', chainId: ctx.chainId, failedCount: failedAddresses.length },
          `retrying ${failedAddresses.length} failed vaults individually`,
        )
        const retryResults = await Promise.all(
          failedAddresses.map(addr => fetchVaultIndividually(addr)),
        )
        for (const vault of retryResults) {
          if (vault) {
            vaults.push(vault)
          }
        }
      }
      else if (hasTransportError) {
        const transportFailedCount = results.filter(r => r.transportError).length
        logger.warn(
          {
            ctx: 'vault/fetchBatch',
            chainId: ctx.chainId,
            kind: 'rpc-transport',
            failedCount: transportFailedCount,
            batchSize: batchAddresses.length,
          },
          'batch transport failure — skipping individual retries',
        )
      }

      return vaults
    }

    // Fallback to individual calls if EVC not available
    const res = await Promise.all(batchAddresses.map(addr => fetchVaultIndividually(addr)))
    return res.filter(o => !!o) as Vault[]
  }

  // Process batches in parallel rounds
  for (let round = 0; round < parallelRounds; round++) {
    if (ctx.isAborted?.()) {
      return
    }

    // Get batches for this round
    const roundStart = round * parallelBatches * batchSize
    const roundBatches: string[][] = []

    for (let b = 0; b < parallelBatches; b++) {
      const batchStart = roundStart + b * batchSize
      if (batchStart >= verifiedVaults.length) break
      roundBatches.push(verifiedVaults.slice(batchStart, batchStart + batchSize))
    }

    // Fetch all batches in this round in parallel
    const roundResults = await Promise.all(roundBatches.map(batch => fetchBatch(batch)))

    if (ctx.isAborted?.()) return

    let validVaults = roundResults.flat()

    // Re-fetch Pyth-powered vaults with simulation to get fresh prices
    // Pyth prices are only valid for ~2 minutes after on-chain update
    if (ctx.coreAddresses?.evc && ctx.pythHermesUrl) {
      const pythVaultEntries = validVaults
        .map((vault) => {
          const feeds = collectPythFeedIds(vault.oracleDetailedInfo)
          return feeds.length > 0 ? { key: vault.address, feeds, args: [vault.address] } : null
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)

      if (pythVaultEntries.length > 0) {
        const refreshedMap = await executeBatchLensWithPythSimulation<Record<string, unknown>>(
          pythVaultEntries,
          ctx.lensAddresses.vaultLens as Address,
          eulerVaultLensABI,
          'getVaultInfoFull',
          ctx.coreAddresses.evc,
          ctx.rpcUrl,
          ctx.pythHermesUrl,
        )

        if (ctx.isAborted?.()) return

        validVaults = validVaults.map((vault) => {
          const raw = refreshedMap.get(vault.address)
          if (!raw) return vault
          try {
            return processRawVaultData(raw, vault.address, ctx.verifiedVaultAddresses)
          }
          catch (e) {
            logger.error({ ctx: 'vault/pythRefresh', chainId: ctx.chainId, err: e }, 'failed to apply Pyth refresh')
            return vault
          }
        })
      }
    }

    // Populate assetPriceInfo and unitOfAccountPriceInfo for USD conversion
    const utilsLensAddress = ctx.lensAddresses.utilsLens
    validVaults = await Promise.all(
      validVaults.map(async (vault) => {
        const [assetPriceInfo, unitOfAccountPriceInfo] = await Promise.all([
          resolveAssetPriceInfo(ctx.rpcUrl, utilsLensAddress, vault.asset.address),
          resolveUnitOfAccountPriceInfo(ctx.rpcUrl, utilsLensAddress, vault.unitOfAccount),
        ])
        return { ...vault, assetPriceInfo, unitOfAccountPriceInfo }
      }),
    )

    if (ctx.isAborted?.()) return

    const isFinished = (round + 1) * parallelBatches * batchSize >= verifiedVaults.length

    yield {
      vaults: validVaults,
      isFinished,
    }
  }
}

export const fetchEarnVaults = async function* (
  ctx: FetchVaultContext,
  vaultAddresses?: string[],
): AsyncGenerator<
  VaultIteratorResult<EarnVault>,
  void,
  unknown
> {
  const client = getPublicClient(ctx.rpcUrl)

  const verifiedVaults = vaultAddresses || ctx.earnVaultAddresses

  // Start block prefetch in parallel - will be awaited when needed for APY calculation
  const blockCachePromise = fetchBlockDataForAPY(ctx.rpcUrl, ctx.chainId)

  // Helper to fetch a single vault (lens + price only, APY calculated after)
  type PartialEarnVault = Omit<EarnVault, 'interestRateInfo'> & { decimals: bigint }

  // Earn vaults are fetched in parallel below. If the RPC endpoint dies mid-batch
  // every parallel fetch will fail at roughly the same instant — instead of logging
  // N near-identical "RPC timeout" lines (the root cause of the 568-row BetterStack
  // incident), let the first transport failure log normally and silently drop the
  // rest in this batch. A genuine on-chain revert from one specific vault still
  // logs because it isn't classified as transport.
  //
  // Race safety: the check-then-set on `transportFailureLogged` looks like a
  // TOCTOU but is safe today because every line in the catch handler runs
  // synchronously — JavaScript microtasks run to completion without preemption,
  // so the first rejected promise's catch sets the flag before any sibling's
  // catch starts. DO NOT introduce an `await` between the check and the set
  // without redesigning this as a post-batch dedup over `Promise.allSettled`.
  let transportFailureLogged = false

  const fetchVaultData = async (vaultAddress: string): Promise<PartialEarnVault | undefined> => {
    try {
      const data = await client.readContract({
        address: ctx.lensAddresses.eulerEarnVaultLens as Address,
        abi: eulerEarnVaultLensABI,
        functionName: 'getVaultInfoFull',
        args: [vaultAddress],
      }) as Record<string, unknown>

      const strategies = (data.strategies as EarnVaultStrategyInfo[]).map((strategy) => {
        return {
          strategy: strategy.strategy,
          allocatedAssets: strategy.allocatedAssets,
          availableAssets: strategy.availableAssets,
          currentAllocationCap: strategy.currentAllocationCap,
          pendingAllocationCap: strategy.pendingAllocationCap,
          pendingAllocationCapValidAt: strategy.pendingAllocationCapValidAt,
          removableAt: strategy.removableAt,
          info: strategy.info,
        }
      })

      const assetPriceInfo = await resolveAssetPriceInfo(
        ctx.rpcUrl,
        ctx.lensAddresses.utilsLens,
        data.asset as string,
      )

      return {
        verified: ctx.earnVaultAddresses.includes(vaultAddress),
        type: 'earn',
        address: data.vault,
        name: data.vaultName,
        symbol: data.vaultSymbol,
        decimals: data.vaultDecimals,
        totalShares: data.totalShares,
        totalAssets: data.totalAssets,
        lostAssets: data.lostAssets,
        availableAssets: data.availableAssets,
        timelock: data.timelock,
        performanceFee: data.performanceFee,
        feeReceiver: data.feeReceiver,
        owner: data.owner,
        creator: data.creator,
        curator: data.curator,
        guardian: data.guardian,
        evc: data.evc,
        permit2: data.permit2,
        pendingTimelock: data.pendingTimelock,
        pendingTimelockValidAt: data.pendingTimelockValidAt,
        pendingGuardian: data.pendingGuardian,
        pendingGuardianValidAt: data.pendingGuardianValidAt,
        supplyQueue: data.supplyQueue,
        asset: {
          address: data.asset,
          name: data.assetName,
          symbol: data.assetSymbol,
          decimals: data.assetDecimals,
        },
        strategies,
        assetPriceInfo,
      } as PartialEarnVault
    }
    catch (e) {
      const summary = summarizeViemError(e)
      if (summary.isTransport) {
        if (transportFailureLogged) return undefined
        transportFailureLogged = true
      }
      logConciseFetchError('vault/fetchEarnVault', ctx.chainId, vaultAddress, e)
      return undefined
    }
  }

  // Fetch all vault data in parallel with block prefetch
  const allVaultDataPromises = verifiedVaults.map(addr => fetchVaultData(addr))

  // Wait for both block cache and vault data
  const [blockCache, allVaultData] = await Promise.all([
    blockCachePromise,
    Promise.all(allVaultDataPromises),
  ])

  if (ctx.isAborted?.()) return

  // Calculate APY for all vaults (using cached block data)
  const vaultsWithAPY = await Promise.all(
    allVaultData
      .filter((v): v is PartialEarnVault => v !== undefined)
      .map(async (vaultData) => {
        const supplyAPYNumber = blockCache
          ? await calculateEarnVaultAPYWithCache(vaultData.address, vaultData.decimals, blockCache, ctx.rpcUrl, ctx.chainId)
          : 0
        return {
          ...vaultData,
          interestRateInfo: {
            borrowAPY: 0n,
            borrowSPY: 0n,
            borrows: 0n,
            cash: vaultData.totalAssets,
            supplyAPY: valueToNano(supplyAPYNumber, 25),
          },
        } as EarnVault
      }),
  )

  if (ctx.isAborted?.()) return

  yield {
    vaults: vaultsWithAPY,
    isFinished: true,
  }
}
