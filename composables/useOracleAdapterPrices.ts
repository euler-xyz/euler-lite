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
import { getEulerSdk } from '~/composables/useEulerSdk'
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

  const fetchPrices = async () => {
    const stepList = steps.value
    const evcAddress = eulerCoreAddresses.value?.evc
    if (!stepList.length || !evcAddress || !chainId.value) {
      prices.value = new Map()
      return
    }

    try {
      const sdk = await getEulerSdk()
      // The SDK is linked from a workspace and ships its own viem (2.43.x), so
      // its PublicClient is structurally similar but not identical to the app's
      // viem (2.48.x) — cast once at the boundary.
      const provider = sdk.providerService.getProvider(chainId.value) as unknown as PublicClient

      // 1. Build known decimals
      const knownDecimals = buildKnownDecimals(sourceVaults.value, collateralVaults.value)

      // 2. Find unknown decimals
      const unknownAddresses = findUnknownDecimalsAddresses(stepList, knownDecimals)

      // 3. Fetch missing decimals if needed
      if (unknownAddresses.length) {
        const fetched = await fetchMissingDecimals(unknownAddresses, evcAddress, provider)
        fetched.forEach((dec, addr) => knownDecimals.set(addr, dec))
      }

      // 4. Build Pyth update batch items for the adapters being quoted
      const adapterList = getOracleRouteAdapters(stepList)
      const { items: pythItems } = await buildPythBatchItemsFromFeeds(
        collectPythFeedsFromAdapters(adapterList),
        provider,
        PYTH_HERMES_URL,
      )

      // 5. Build price query batch items (skipping adapters with unknown decimals)
      const { quoteRequests, items: priceItems } = buildPriceQueryItems(stepList, knownDecimals)

      // 6. Execute single batchSimulation
      const allItems = [...pythItems, ...priceItems]
      const batchResults = await evcBatchCall(provider, evcAddress, allItems)

      // 7. Decode price results (skip Pyth update results)
      const priceResults = batchResults.slice(pythItems.length)
      prices.value = decodePriceResults(quoteRequests, priceResults)
    }
    catch (err) {
      logWarn('oracleAdapterPrices/fetchPrices', err)
      prices.value = new Map()
    }
  }

  watch(steps, async () => {
    if (!steps.value.length) {
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
