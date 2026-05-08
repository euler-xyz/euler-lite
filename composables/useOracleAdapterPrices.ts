import {
  collectPythFeedsFromAdapters,
  type SecuritizeCollateralVault,
  type EVault,
  type OracleAdapterEntry,
} from '@eulerxyz/euler-v2-sdk'
import { buildPythBatchItemsFromFeeds } from '~/utils/pyth'
import { nanoToValue } from '~/utils/crypto-utils'
import { buildBatchItem } from '~/utils/multicall'
import { getPublicClient } from '~/utils/public-client'
import { logWarn } from '~/utils/errorHandling'
import { USD_ADDRESS, EUR_ADDRESS, BTC_ADDRESS, ETH_ADDRESS } from '~/entities/constants'
import { type BatchItem, EVC_ABI, type BatchItemResult } from '~/abis/evc'
import { encodeFunctionData, type Address, decodeFunctionResult, type Hex } from 'viem'
import { erc20DecimalsAbi } from '~/abis/erc20'
import { vaultConvertToAssetsAbi } from '~/abis/vault'
import { priceOracleAbi } from '~/abis/oracle'
import type { ComputedRef } from 'vue'

export type AdapterPriceInfo = {
  rate: number
  success: boolean
}

type OracleAdapterQuoteRequest = {
  kind: 'erc4626-convertToAssets' | 'oracle-getQuote'
  adapter: OracleAdapterEntry
  target: Address
  amountIn: bigint
  base: Address
  quote: Address
  quoteDecimals: number
}

const getOracleAdapterKey = (adapter: OracleAdapterEntry) =>
  `${adapter.oracle.toLowerCase()}:${adapter.base.toLowerCase()}:${adapter.quote.toLowerCase()}`

const buildKnownDecimals = (
  sourceVaults: EVault[],
  collateralVaults: (EVault | SecuritizeCollateralVault)[],
): Map<string, number> => {
  const decimals = new Map<string, number>()

  // UoA constants
  decimals.set(USD_ADDRESS.toLowerCase(), 18)
  decimals.set(EUR_ADDRESS.toLowerCase(), 18)

  // Well-known non-ERC20 placeholder addresses
  decimals.set(BTC_ADDRESS.toLowerCase(), 18)
  decimals.set(ETH_ADDRESS.toLowerCase(), 18)

  const addVaultDecimals = (vault: EVault | SecuritizeCollateralVault) => {
    if (vault.asset?.address && vault.asset?.decimals !== undefined) {
      decimals.set(vault.asset.address.toLowerCase(), Number(vault.asset.decimals))
    }
    if (vault.address && vault.shares.decimals !== undefined) {
      decimals.set(vault.address.toLowerCase(), Number(vault.shares.decimals))
    }
  }

  // Add unit of account decimals from source vaults
  sourceVaults.forEach((vault) => {
    addVaultDecimals(vault)
    if (vault.unitOfAccount) {
      decimals.set(vault.unitOfAccount.address.toLowerCase(), Number(vault.unitOfAccount.decimals))
    }
  })

  collateralVaults.forEach(addVaultDecimals)

  return decimals
}

const findUnknownDecimalsAddresses = (
  adapters: OracleAdapterEntry[],
  knownDecimals: Map<string, number>,
): string[] => {
  const unknown = new Set<string>()

  adapters.forEach((adapter) => {
    const base = adapter.base.toLowerCase()
    const quote = adapter.quote.toLowerCase()
    if (!knownDecimals.has(base)) unknown.add(base)
    if (!knownDecimals.has(quote)) unknown.add(quote)
  })

  return [...unknown]
}

const fetchMissingDecimals = async (
  addresses: string[],
  evcAddress: string,
  rpcUrl: string,
): Promise<Map<string, number>> => {
  const result = new Map<string, number>()
  if (!addresses.length) return result

  const items: BatchItem[] = addresses.map(addr =>
    buildBatchItem(addr, encodeFunctionData({
      abi: erc20DecimalsAbi,
      functionName: 'decimals',
    })),
  )

  const client = getPublicClient(rpcUrl)

  try {
    const callData = encodeFunctionData({
      abi: EVC_ABI,
      functionName: 'batchSimulation',
      args: [items],
    })

    const callResult = await client.call({
      to: evcAddress as Address,
      data: callData,
      value: 0n,
    })

    if (!callResult.data) {
      addresses.forEach(addr => result.set(addr.toLowerCase(), 18))
      return result
    }

    const decoded = decodeFunctionResult({
      abi: EVC_ABI,
      functionName: 'batchSimulation',
      data: callResult.data,
    })

    const batchResults = decoded[0] as unknown as BatchItemResult[]

    batchResults.forEach((res, i) => {
      if (res.success) {
        try {
          const decimals = decodeFunctionResult({
            abi: erc20DecimalsAbi,
            functionName: 'decimals',
            data: res.result as Hex,
          }) as number
          result.set(addresses[i].toLowerCase(), decimals)
        }
        catch {
          result.set(addresses[i].toLowerCase(), 18)
        }
      }
      else {
        // Non-ERC20 addresses (e.g. BTC/ETH placeholders) will fail
        // decimals() calls — default to 18 so their adapters are not
        // filtered out of price queries.
        result.set(addresses[i].toLowerCase(), 18)
      }
    })
  }
  catch {
    // Batch call failed — return empty map so all adapters with
    // unknown decimals are skipped rather than mis-priced.
  }

  return result
}

const buildPriceQueryItems = (
  adapters: OracleAdapterEntry[],
  decimals: Map<string, number>,
): { quoteRequests: OracleAdapterQuoteRequest[], items: BatchItem[] } => {
  const quoteRequests: OracleAdapterQuoteRequest[] = []
  for (const adapter of adapters) {
    const baseDecimals = decimals.get(adapter.base.toLowerCase())
    const quoteDecimals = decimals.get(adapter.quote.toLowerCase())
    if (baseDecimals === undefined || quoteDecimals === undefined) continue

    quoteRequests.push({
      kind: adapter.name === 'ERC4626Vault' ? 'erc4626-convertToAssets' : 'oracle-getQuote',
      adapter,
      target: adapter.oracle,
      amountIn: 10n ** BigInt(baseDecimals),
      base: adapter.base,
      quote: adapter.quote,
      quoteDecimals,
    })
  }

  const items = quoteRequests.map((request) => {
    if (request.kind === 'erc4626-convertToAssets') {
      const callData = encodeFunctionData({
        abi: vaultConvertToAssetsAbi,
        functionName: 'convertToAssets',
        args: [request.amountIn],
      })
      return buildBatchItem(request.target, callData)
    }

    const callData = encodeFunctionData({
      abi: priceOracleAbi,
      functionName: 'getQuote',
      args: [request.amountIn, request.base, request.quote],
    })
    return buildBatchItem(request.target, callData)
  })

  return { quoteRequests, items }
}

const decodePriceResults = (
  quoteRequests: OracleAdapterQuoteRequest[],
  results: BatchItemResult[],
): Map<string, AdapterPriceInfo> => {
  const prices = new Map<string, AdapterPriceInfo>()

  quoteRequests.forEach((request, i) => {
    const key = getOracleAdapterKey(request.adapter)
    const res = results[i]

    if (!res?.success) {
      prices.set(key, { rate: 0, success: false })
      return
    }

    try {
      const isERC4626 = request.kind === 'erc4626-convertToAssets'
      const decoded = isERC4626
        ? decodeFunctionResult({
            abi: vaultConvertToAssetsAbi,
            functionName: 'convertToAssets',
            data: res.result as Hex,
          })
        : decodeFunctionResult({
            abi: priceOracleAbi,
            functionName: 'getQuote',
            data: res.result as Hex,
          })

      const outAmount = decoded as bigint
      const rate = nanoToValue(outAmount, request.quoteDecimals)

      prices.set(key, { rate, success: true })
    }
    catch {
      prices.set(key, { rate: 0, success: false })
    }
  })

  return prices
}

export const useOracleAdapterPrices = (
  adapters: ComputedRef<OracleAdapterEntry[]>,
  sourceVaults: ComputedRef<EVault[]>,
  collateralVaults: ComputedRef<(EVault | SecuritizeCollateralVault)[]>,
) => {
  const prices: Ref<Map<string, AdapterPriceInfo>> = shallowRef(new Map())
  const isLoading = ref(false)

  const { PYTH_HERMES_URL } = useEulerConfig()
  const { client: rpcClient, rpcUrl } = useRpcClient()
  const { eulerCoreAddresses } = useEulerAddresses()

  const fetchPrices = async () => {
    const adapterList = adapters.value
    const evcAddress = eulerCoreAddresses.value?.evc
    if (!adapterList.length || !evcAddress || !rpcUrl.value) {
      prices.value = new Map()
      return
    }

    try {
      const client = rpcClient.value!

      // 1. Build known decimals
      const knownDecimals = buildKnownDecimals(sourceVaults.value, collateralVaults.value)

      // 2. Find unknown decimals
      const unknownAddresses = findUnknownDecimalsAddresses(adapterList, knownDecimals)

      // 3. Fetch missing decimals if needed
      if (unknownAddresses.length) {
        const fetched = await fetchMissingDecimals(unknownAddresses, evcAddress, rpcUrl.value)
        fetched.forEach((dec, addr) => knownDecimals.set(addr, dec))
      }

      // 4. Build Pyth update batch items for the adapters being quoted
      const { items: pythItems, totalFee } = await buildPythBatchItemsFromFeeds(
        collectPythFeedsFromAdapters(adapterList),
        rpcUrl.value,
        PYTH_HERMES_URL,
      )

      // 5. Build price query batch items (skipping adapters with unknown decimals)
      const { quoteRequests, items: priceItems } = buildPriceQueryItems(adapterList, knownDecimals)

      // 6. Execute single batchSimulation
      const allItems = [...pythItems, ...priceItems]
      const batchCallData = encodeFunctionData({
        abi: EVC_ABI,
        functionName: 'batchSimulation',
        args: [allItems],
      })

      const callResult = await client.call({
        to: evcAddress as Address,
        data: batchCallData,
        value: totalFee,
      })

      if (!callResult.data) {
        prices.value = new Map()
        return
      }

      const decoded = decodeFunctionResult({
        abi: EVC_ABI,
        functionName: 'batchSimulation',
        data: callResult.data,
      })

      const batchResults = decoded[0] as unknown as BatchItemResult[]

      // 7. Decode price results (skip Pyth update results)
      const priceResults = batchResults.slice(pythItems.length)
      prices.value = decodePriceResults(quoteRequests, priceResults)
    }
    catch (err) {
      logWarn('oracleAdapterPrices/fetchPrices', err)
      prices.value = new Map()
    }
  }

  watch(adapters, async () => {
    if (!adapters.value.length) {
      prices.value = new Map()
      return
    }
    isLoading.value = true
    await fetchPrices()
    isLoading.value = false
  }, { immediate: true })

  return {
    prices,
    isLoading,
  }
}
