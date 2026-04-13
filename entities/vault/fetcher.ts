import { zeroAddress, type Address } from 'viem'
import type {
  Vault,
  SecuritizeVault,
  EarnVault,
  EarnVaultStrategyInfo,
  VaultIteratorResult,
} from './types'
import { resolveAssetPriceInfo, resolveUnitOfAccountPriceInfo } from './pricing'
import { calculateEarnVaultAPYFromExchangeRate, calculateEarnVaultAPYWithCache, fetchBlockDataForAPY } from './apy'
import { logWarn } from '~/utils/errorHandling'
import { BATCH_SIZE_VAULT_FETCH, BATCH_SIZE_PARALLEL_ROUNDS } from '~/entities/tuning-constants'
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
    hookTarget: raw.hookTarget,
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
 *
 * @param vaultAddress - The vault address to fetch
 * @param feeds - Pre-collected Pyth feeds for this vault
 * @param rpcUrl - JSON-RPC provider URL
 * @param vaultLensAddress - Vault lens contract address
 * @param evcAddress - EVC contract address
 * @param hermesEndpoint - Pyth Hermes endpoint URL
 * @param verifiedVaultAddresses - List of verified vault addresses
 * @returns Vault with fresh Pyth prices, or undefined if simulation fails
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

export const fetchVault = async (vaultAddress: string): Promise<Vault> => {
  const { PYTH_HERMES_URL } = useEulerConfig()
  const { client: rpcClient, rpcUrl } = useRpcClient()
  const { loadEulerConfig, isReady } = useEulerAddresses()
  const { verifiedVaultAddresses } = useEulerLabels()

  if (!isReady.value) {
    loadEulerConfig()
    await until(computed(() => isReady.value)).toBeTruthy()
  }
  const { eulerLensAddresses, eulerCoreAddresses } = useEulerAddresses()

  const client = rpcClient.value!

  // Standard query first (fast path for non-Pyth vaults)
  const raw = await client.readContract({
    address: eulerLensAddresses.value!.vaultLens as Address,
    abi: eulerVaultLensABI,
    functionName: 'getVaultInfoFull',
    args: [vaultAddress],
  }) as Record<string, unknown>
  let vault = processRawVaultData(raw, vaultAddress, verifiedVaultAddresses.value)

  // Check if vault uses Pyth oracles
  const feeds = collectPythFeedIds(vault.oracleDetailedInfo)

  // ALWAYS re-query with simulation if Pyth detected
  // Pyth prices are only valid for ~2 minutes after on-chain update,
  // so we need fresh prices even if current query succeeded
  if (feeds.length > 0 && eulerCoreAddresses.value?.evc && PYTH_HERMES_URL) {
    const vaultWithFreshPrice = await fetchVaultWithPythSimulation(
      vaultAddress,
      feeds,
      rpcUrl.value,
      eulerLensAddresses.value!.vaultLens,
      eulerCoreAddresses.value.evc,
      PYTH_HERMES_URL,
      verifiedVaultAddresses.value,
    )
    if (vaultWithFreshPrice) {
      vault = vaultWithFreshPrice
    }
  }

  if (eulerLensAddresses.value?.utilsLens) {
    const [assetPriceInfo, unitOfAccountPriceInfo] = await Promise.all([
      resolveAssetPriceInfo(rpcUrl.value, eulerLensAddresses.value.utilsLens, vault.asset.address),
      resolveUnitOfAccountPriceInfo(rpcUrl.value, eulerLensAddresses.value.utilsLens, vault.unitOfAccount),
    ])
    vault = { ...vault, assetPriceInfo, unitOfAccountPriceInfo }
  }

  return vault
}

export const fetchSecuritizeVault = async (vaultAddress: string): Promise<SecuritizeVault> => {
  const { client: rpcClient, rpcUrl } = useRpcClient()
  const { loadEulerConfig, isReady } = useEulerAddresses()
  const { verifiedVaultAddresses } = useEulerLabels()

  if (!isReady.value) {
    loadEulerConfig()
    await until(computed(() => isReady.value)).toBeTruthy()
  }
  const { eulerLensAddresses } = useEulerAddresses()

  const client = rpcClient.value!

  const data = await client.readContract({
    address: eulerLensAddresses.value!.utilsLens as Address,
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

  const assetPriceInfo = eulerLensAddresses.value?.utilsLens
    ? await resolveAssetPriceInfo(
      rpcUrl.value,
      eulerLensAddresses.value.utilsLens,
      data.asset as string,
    )
    : undefined

  return {
    type: 'securitize',
    verified: verifiedVaultAddresses.value.includes(vaultAddress),
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

export const fetchEarnVault = async (vaultAddress: string): Promise<EarnVault> => {
  const { client: rpcClient, rpcUrl } = useRpcClient()
  const { earnVaults } = useEulerLabels()
  const { loadEulerConfig, isReady } = useEulerAddresses()

  if (!isReady.value) {
    loadEulerConfig()
    await until(computed(() => isReady.value)).toBeTruthy()
  }

  const { eulerLensAddresses } = useEulerAddresses()

  const client = rpcClient.value!

  const data = await client.readContract({
    address: eulerLensAddresses.value!.eulerEarnVaultLens as Address,
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
  )

  const assetPriceInfo = await resolveAssetPriceInfo(
    rpcUrl.value,
    eulerLensAddresses.value!.utilsLens,
    data.asset as string,
  )

  const verified = earnVaults.value.includes(vaultAddress)

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
  vaultAddresses?: string[],
): AsyncGenerator<
    VaultIteratorResult<Vault>,
    void,
    unknown
  > {
  const { PYTH_HERMES_URL } = useEulerConfig()
  const { client: rpcClient, rpcUrl } = useRpcClient()
  const { eulerLensAddresses, eulerCoreAddresses, chainId } = useEulerAddresses()
  const { verifiedVaultAddresses } = useEulerLabels()

  const startChainId = chainId.value

  await until(
    computed(() => eulerLensAddresses.value?.vaultLens),
  ).toBeTruthy()

  if (!eulerLensAddresses.value?.vaultLens) {
    throw new Error('Euler addresses not loaded yet')
  }

  const client = rpcClient.value!

  // Use provided addresses if available, otherwise fall back to verifiedVaultAddresses
  // (pre-categorization by caller is preferred to eliminate per-vault RPC calls)
  const verifiedVaults = vaultAddresses || verifiedVaultAddresses.value
  const batchSize = BATCH_SIZE_VAULT_FETCH
  const parallelBatches = BATCH_SIZE_PARALLEL_ROUNDS

  const batchCount = Math.ceil(verifiedVaults.length / batchSize)
  const parallelRounds = Math.ceil(batchCount / parallelBatches)

  // Helper to process raw vault data into Vault object (delegates to shared function)
  // Uses verifiedVaultAddresses to correctly set the `verified` flag — avoids
  // marking dynamically-resolved vaults (e.g. from user positions) as verified
  // when they get swept into refreshVaults().
  const processVaultResult = (raw: Record<string, unknown>, vaultAddress: string): Vault | undefined => {
    try {
      return processRawVaultData(raw, vaultAddress, verifiedVaultAddresses.value)
    }
    catch (e) {
      logWarn('vault/processResult', e, { severity: 'error' })
      return undefined
    }
  }

  // Helper to fetch vault individually (used as fallback)
  const fetchVaultIndividually = async (vaultAddress: string): Promise<Vault | undefined> => {
    try {
      const raw = await client.readContract({
        address: eulerLensAddresses.value!.vaultLens as Address,
        abi: eulerVaultLensABI,
        functionName: 'getVaultInfoFull',
        args: [vaultAddress],
      }) as Record<string, unknown>
      return processVaultResult(raw, vaultAddress)
    }
    catch (e) {
      logWarn('vault/fetchIndividual', e, { severity: 'error' })
      return undefined
    }
  }

  // Helper to fetch a batch of vaults using EVC batchSimulation
  const fetchBatch = async (batchAddresses: string[]): Promise<Vault[]> => {
    // Use EVC batchSimulation if available for batched RPC calls
    if (eulerCoreAddresses.value?.evc) {
      const calls = batchAddresses.map(vaultAddress => ({
        functionName: 'getVaultInfoFull',
        args: [vaultAddress],
      }))

      const results = await batchLensCalls<Record<string, unknown>>(
        eulerCoreAddresses.value.evc,
        eulerLensAddresses.value!.vaultLens,
        eulerVaultLensABI,
        calls,
        rpcUrl.value,
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

      // Only retry individually for on-chain reverts, not transport errors (403, network failures)
      if (failedAddresses.length > 0 && !hasTransportError) {
        logWarn('vault/fetchBatch', `Retrying ${failedAddresses.length} failed vaults individually`)
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
        logWarn('vault/fetchBatch', `Skipping individual retries — RPC transport error`)
      }

      return vaults
    }

    // Fallback to individual calls if EVC not available
    const res = await Promise.all(batchAddresses.map(addr => fetchVaultIndividually(addr)))
    return res.filter(o => !!o) as Vault[]
  }

  // Process batches in parallel rounds
  for (let round = 0; round < parallelRounds; round++) {
    if (chainId.value !== startChainId) {
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

    if (chainId.value !== startChainId) return

    let validVaults = roundResults.flat()

    // Re-fetch Pyth-powered vaults with simulation to get fresh prices
    // Pyth prices are only valid for ~2 minutes after on-chain update
    if (eulerCoreAddresses.value?.evc && PYTH_HERMES_URL) {
      const pythVaultEntries = validVaults
        .map((vault) => {
          const feeds = collectPythFeedIds(vault.oracleDetailedInfo)
          return feeds.length > 0 ? { key: vault.address, feeds, args: [vault.address] } : null
        })
        .filter((entry): entry is NonNullable<typeof entry> => entry !== null)

      if (pythVaultEntries.length > 0) {
        const refreshedMap = await executeBatchLensWithPythSimulation<Record<string, unknown>>(
          pythVaultEntries,
          eulerLensAddresses.value!.vaultLens as Address,
          eulerVaultLensABI,
          'getVaultInfoFull',
          eulerCoreAddresses.value!.evc,
          rpcUrl.value,
          PYTH_HERMES_URL,
        )

        if (chainId.value !== startChainId) return

        validVaults = validVaults.map((vault) => {
          const raw = refreshedMap.get(vault.address)
          if (!raw) return vault
          try {
            return processRawVaultData(raw, vault.address, verifiedVaultAddresses.value)
          }
          catch (e) {
            logWarn('vault/pythRefresh', e, { severity: 'error' })
            return vault
          }
        })
      }
    }

    // Populate assetPriceInfo and unitOfAccountPriceInfo for USD conversion
    if (eulerLensAddresses.value?.utilsLens) {
      const utilsLensAddress = eulerLensAddresses.value.utilsLens
      validVaults = await Promise.all(
        validVaults.map(async (vault) => {
          const [assetPriceInfo, unitOfAccountPriceInfo] = await Promise.all([
            resolveAssetPriceInfo(rpcUrl.value, utilsLensAddress, vault.asset.address),
            resolveUnitOfAccountPriceInfo(rpcUrl.value, utilsLensAddress, vault.unitOfAccount),
          ])
          return { ...vault, assetPriceInfo, unitOfAccountPriceInfo }
        }),
      )

      if (chainId.value !== startChainId) return
    }

    const isFinished = (round + 1) * parallelBatches * batchSize >= verifiedVaults.length

    yield {
      vaults: validVaults,
      isFinished,
    }
  }
}

export const fetchEarnVaults = async function* (vaultAddresses?: string[]): AsyncGenerator<
  VaultIteratorResult<EarnVault>,
  void,
  unknown
> {
  const { client: rpcClient, rpcUrl } = useRpcClient()
  const { eulerLensAddresses, chainId } = useEulerAddresses()
  const { earnVaults, isLoading } = useEulerLabels()

  const startChainId = chainId.value

  await until(
    computed(() => {
      return (
        eulerLensAddresses.value?.eulerEarnVaultLens
        && eulerLensAddresses.value?.utilsLens
        && !isLoading.value
      )
    }),
  ).toBeTruthy()

  if (
    !eulerLensAddresses.value?.eulerEarnVaultLens
    || !eulerLensAddresses.value?.utilsLens
  ) {
    throw new Error('Euler Earn addresses not loaded yet')
  }

  const client = rpcClient.value!

  const verifiedVaults = vaultAddresses || earnVaults.value

  // Start block prefetch in parallel - will be awaited when needed for APY calculation
  const blockCachePromise = fetchBlockDataForAPY()

  // Helper to fetch a single vault (lens + price only, APY calculated after)
  type PartialEarnVault = Omit<EarnVault, 'interestRateInfo'> & { decimals: bigint }

  const fetchVaultData = async (vaultAddress: string): Promise<PartialEarnVault | undefined> => {
    try {
      const data = await client.readContract({
        address: eulerLensAddresses.value!.eulerEarnVaultLens as Address,
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
        rpcUrl.value,
        eulerLensAddresses.value!.utilsLens,
        data.asset as string,
      )

      return {
        verified: earnVaults.value.includes(vaultAddress),
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
      logWarn('vault/fetchEarnVault', e, { severity: 'error' })
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

  if (chainId.value !== startChainId) return

  // Calculate APY for all vaults (using cached block data)
  const vaultsWithAPY = await Promise.all(
    allVaultData
      .filter((v): v is PartialEarnVault => v !== undefined)
      .map(async (vaultData) => {
        const supplyAPYNumber = blockCache
          ? await calculateEarnVaultAPYWithCache(vaultData.address, vaultData.decimals, blockCache)
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

  if (chainId.value !== startChainId) return

  yield {
    vaults: vaultsWithAPY,
    isFinished: true,
  }
}
