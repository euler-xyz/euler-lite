import { encodeFunctionData, decodeFunctionResult, type Address, type Hex } from 'viem'
import type { ComputedRef } from 'vue'
import { EVC_ABI, type BatchItem, type BatchItemResult } from '~/abis/evc'
import { erc20DecimalsAbi } from '~/abis/erc20'
import { priceOracleAbi } from '~/abis/oracle'
import { vaultConvertToAssetsAbi } from '~/abis/vault'
import { USD_ADDRESS, EUR_ADDRESS, BTC_ADDRESS, ETH_ADDRESS } from '~/entities/constants'
import type { OracleAdapterEntry } from '~/entities/oracle'
import type { Vault, SecuritizeVault } from '~/entities/vault'
import { buildPythBatchItems } from '~/utils/pyth'
import { nanoToValue } from '~/utils/crypto-utils'
import { buildBatchItem } from '~/utils/multicall'
import { getPublicClient } from '~/utils/public-client'
import { logWarn } from '~/utils/errorHandling'

export type AdapterPriceInfo = {
  rate: number
  success: boolean
}

const getAdapterKey = (adapter: OracleAdapterEntry) =>
  `${adapter.oracle.toLowerCase()}:${adapter.base.toLowerCase()}:${adapter.quote.toLowerCase()}`

const buildKnownDecimals = (
  sourceVaults: Vault[],
  collateralVaults: (Vault | SecuritizeVault)[],
): Map<string, number> => {
  const decimals = new Map<string, number>()

  // UoA constants
  decimals.set(USD_ADDRESS.toLowerCase(), 18)
  decimals.set(EUR_ADDRESS.toLowerCase(), 18)

  // Well-known non-ERC20 placeholder addresses
  decimals.set(BTC_ADDRESS.toLowerCase(), 18)
  decimals.set(ETH_ADDRESS.toLowerCase(), 18)

  const addVaultDecimals = (vault: Vault | SecuritizeVault) => {
    if (vault.asset?.address && vault.asset?.decimals !== undefined) {
      decimals.set(vault.asset.address.toLowerCase(), Number(vault.asset.decimals))
    }
    if (vault.address && vault.decimals !== undefined) {
      decimals.set(vault.address.toLowerCase(), Number(vault.decimals))
    }
  }

  // Add unit of account decimals from source vaults
  sourceVaults.forEach((vault) => {
    addVaultDecimals(vault)
    if (vault.unitOfAccount && vault.unitOfAccountDecimals !== undefined) {
      decimals.set(vault.unitOfAccount.toLowerCase(), Number(vault.unitOfAccountDecimals))
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
): { filteredAdapters: OracleAdapterEntry[], items: BatchItem[] } => {
  const filteredAdapters: OracleAdapterEntry[] = []
  const items: BatchItem[] = []

  for (const adapter of adapters) {
    const baseDecimals = decimals.get(adapter.base.toLowerCase())
    const quoteDecimals = decimals.get(adapter.quote.toLowerCase())
    if (baseDecimals === undefined || quoteDecimals === undefined) continue

    const inAmount = 10n ** BigInt(baseDecimals)

    if (adapter.name === 'ERC4626Vault') {
      const callData = encodeFunctionData({
        abi: vaultConvertToAssetsAbi,
        functionName: 'convertToAssets',
        args: [inAmount],
      })
      items.push(buildBatchItem(adapter.oracle, callData))
    }
    else {
      const callData = encodeFunctionData({
        abi: priceOracleAbi,
        functionName: 'getQuote',
        args: [inAmount, adapter.base, adapter.quote],
      })
      items.push(buildBatchItem(adapter.oracle, callData))
    }

    filteredAdapters.push(adapter)
  }

  return { filteredAdapters, items }
}

const decodePriceResults = (
  adapters: OracleAdapterEntry[],
  results: BatchItemResult[],
  decimals: Map<string, number>,
): Map<string, AdapterPriceInfo> => {
  const prices = new Map<string, AdapterPriceInfo>()

  adapters.forEach((adapter, i) => {
    const key = getAdapterKey(adapter)
    const res = results[i]

    if (!res?.success) {
      prices.set(key, { rate: 0, success: false })
      return
    }

    try {
      const isERC4626 = adapter.name === 'ERC4626Vault'
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
      const quoteDecimals = decimals.get(adapter.quote.toLowerCase()) ?? 18
      const rate = nanoToValue(outAmount, quoteDecimals)

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
  sourceVaults: ComputedRef<Vault[]>,
  collateralVaults: ComputedRef<(Vault | SecuritizeVault)[]>,
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

      // 4. Build Pyth update batch items
      const { items: pythItems, totalFee } = await buildPythBatchItems(
        sourceVaults.value,
        rpcUrl.value,
        PYTH_HERMES_URL,
      )

      // 5. Build price query batch items (skipping adapters with unknown decimals)
      const { filteredAdapters, items: priceItems } = buildPriceQueryItems(adapterList, knownDecimals)

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
      prices.value = decodePriceResults(filteredAdapters, priceResults, knownDecimals)
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
