import {
  collectPythFeedsFromAdapters,
  getOracleRouteAdapters,
  type SecuritizeCollateralVault,
  type EVault,
  type OracleRouteStep,
} from '@eulerxyz/euler-v2-sdk'
import { buildPythBatchItemsFromFeeds } from '~/utils/pyth'
import { nanoToValue } from '~/utils/crypto-utils'
import { buildBatchItem, evcBatchCall } from '~/utils/multicall'
import { logWarn } from '~/utils/errorHandling'
import { USD_ADDRESS, EUR_ADDRESS, BTC_ADDRESS, ETH_ADDRESS } from '~/entities/constants'
import type { BatchItem, BatchItemResult } from '~/abis/evc'
import { encodeFunctionData, type Address, decodeFunctionResult, type Hex, type PublicClient } from 'viem'
import { erc20DecimalsAbi } from '~/abis/erc20'
import { vaultConvertToAssetsAbi } from '~/abis/vault'
import { priceOracleAbi } from '~/abis/oracle'
import { getEulerSdkForChain } from '~/composables/useEulerSdk'
import type { ComputedRef } from 'vue'

export type AdapterPriceInfo = {
  rate: number
  success: boolean
}

type OracleAdapterQuoteRequest = {
  kind: 'erc4626-convertToAssets' | 'oracle-getQuote'
  step: OracleRouteStep
  key: string
  target: Address
  amountIn: bigint
  base: Address
  quote: Address
  quoteDecimals: number
}

export const getOracleRouteStepKey = (step: Pick<OracleRouteStep, 'kind' | 'oracle' | 'base' | 'quote'>) =>
  `${step.kind}:${step.oracle.toLowerCase()}:${step.base.toLowerCase()}:${step.quote.toLowerCase()}`

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
  steps: OracleRouteStep[],
  knownDecimals: Map<string, number>,
): string[] => {
  const unknown = new Set<string>()

  steps.forEach((step) => {
    const base = step.base.toLowerCase()
    const quote = step.quote.toLowerCase()
    if (!knownDecimals.has(base)) unknown.add(base)
    if (!knownDecimals.has(quote)) unknown.add(quote)
  })

  return [...unknown]
}

const fetchMissingDecimals = async (
  addresses: string[],
  evcAddress: string,
  provider: PublicClient,
): Promise<Map<string, number>> => {
  const result = new Map<string, number>()
  if (!addresses.length) return result

  const items: BatchItem[] = addresses.map(addr =>
    buildBatchItem(addr, encodeFunctionData({
      abi: erc20DecimalsAbi,
      functionName: 'decimals',
    })),
  )

  let batchResults: BatchItemResult[]
  try {
    batchResults = await evcBatchCall(provider, evcAddress, items)
  }
  catch {
    // Batch call failed — return empty map so all adapters with
    // unknown decimals are skipped rather than mis-priced.
    return result
  }

  batchResults.forEach((res, i) => {
    if (res.success && res.result && res.result !== '0x') {
      try {
        const decimals = decodeFunctionResult({
          abi: erc20DecimalsAbi,
          functionName: 'decimals',
          data: res.result as Hex,
        }) as number
        result.set(addresses[i].toLowerCase(), decimals)
      }
      catch (err) {
        // Keep unresolved decimals absent so the quote is not mis-scaled.
        logWarn('oracleAdapterPrices/decimals', err)
      }
    }
  })

  return result
}

const buildPriceQueryItems = (
  steps: OracleRouteStep[],
  decimals: Map<string, number>,
): { quoteRequests: OracleAdapterQuoteRequest[], items: BatchItem[] } => {
  const quoteRequests: OracleAdapterQuoteRequest[] = []
  for (const step of steps) {
    const baseDecimals = decimals.get(step.base.toLowerCase())
    const quoteDecimals = decimals.get(step.quote.toLowerCase())
    if (baseDecimals === undefined || quoteDecimals === undefined) continue

    quoteRequests.push({
      kind: step.kind === 'vault' ? 'erc4626-convertToAssets' : 'oracle-getQuote',
      step,
      key: getOracleRouteStepKey(step),
      target: step.oracle,
      amountIn: 10n ** BigInt(baseDecimals),
      base: step.base,
      quote: step.quote,
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
    const res = results[i]

    if (!res?.success) {
      prices.set(request.key, { rate: 0, success: false })
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

      prices.set(request.key, { rate, success: true })
    }
    catch {
      prices.set(request.key, { rate: 0, success: false })
    }
  })

  return prices
}

export const useOracleAdapterPrices = (
  steps: ComputedRef<OracleRouteStep[]>,
  sourceVaults: ComputedRef<EVault[]>,
  collateralVaults: ComputedRef<(EVault | SecuritizeCollateralVault)[]>,
) => {
  const prices: Ref<Map<string, AdapterPriceInfo>> = shallowRef(new Map())
  const isLoading = ref(false)

  const { PYTH_HERMES_URL } = useEulerConfig()
  const { chainId, eulerCoreAddresses } = useEulerAddresses()

  watch(
    [steps, chainId, () => eulerCoreAddresses.value?.evc],
    async ([stepList, currentChainId, evcAddress], _previous, onCleanup) => {
      let cancelled = false
      onCleanup(() => {
        cancelled = true
      })
      prices.value = new Map()
      isLoading.value = false
      if (!stepList.length || !evcAddress || !currentChainId) return

      const knownDecimals = buildKnownDecimals(sourceVaults.value, collateralVaults.value)
      isLoading.value = true
      try {
        const sdk = await getEulerSdkForChain(currentChainId)
        const provider = sdk.providerService.getProvider(currentChainId) as unknown as PublicClient

        const unknownAddresses = findUnknownDecimalsAddresses(stepList, knownDecimals)
        if (unknownAddresses.length) {
          const fetched = await fetchMissingDecimals(unknownAddresses, evcAddress, provider)
          fetched.forEach((dec, addr) => knownDecimals.set(addr, dec))
        }

        const adapterList = getOracleRouteAdapters(stepList)
        const { items: pythItems } = await buildPythBatchItemsFromFeeds(
          collectPythFeedsFromAdapters(adapterList),
          provider,
          PYTH_HERMES_URL,
        )
        const { quoteRequests, items: priceItems } = buildPriceQueryItems(stepList, knownDecimals)
        if (!priceItems.length) return
        const batchResults = await evcBatchCall(provider, evcAddress, [...pythItems, ...priceItems])
        if (!cancelled) {
          prices.value = decodePriceResults(quoteRequests, batchResults.slice(pythItems.length))
        }
      }
      catch (err) {
        if (!cancelled) logWarn('oracleAdapterPrices/fetchPrices', err)
      }
      finally {
        if (!cancelled) isLoading.value = false
      }
    },
    { immediate: true },
  )

  return {
    prices,
    isLoading,
  }
}
