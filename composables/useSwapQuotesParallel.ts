import { encodeFunctionData, type Address, type StateOverride } from 'viem'
import type { SwapApiQuote } from '~/entities/swap'
import type { SwapApiRequestInput } from '~/composables/useSwapApi'
import type { TxPlan } from '~/entities/txPlan'
import {
  getQuoteAmount,
  getQuoteCardScore,
  getQuoteDiffPct,
  pickBestQuote,
  sortQuoteCards,
  type SwapQuoteAmountField,
  type SwapQuoteCard,
  type SwapQuoteCompare,
} from '~/utils/swapQuotes'
import { createRaceGuard } from '~/utils/race-guard'
import { isAbortError } from '~/utils/errorHandling'
import { COWSWAP_PROVIDER_NAME } from '~/entities/cowswap'
import { getTokenUsdValue } from '~/services/pricing/priceProvider'
import { resolveWrappedNativeAddress } from '~/utils/native-currency'
import { applyOperationGuards } from '~/utils/operationGuardRegistry'

type SwapQuotesParallelOptions = {
  amountField: SwapQuoteAmountField
  compare: SwapQuoteCompare
  transformQuote?: (quote: SwapApiQuote, provider: string) => SwapApiQuote
  includeCowSwap?: boolean
  buildTxPlanForQuote?: (quote: SwapApiQuote, provider: string) => Promise<TxPlan>
}

type SwapQuotesRequestOptions = {
  providers?: string[]
  errorMessage?: string
}

export const useSwapQuotesParallel = (options: SwapQuotesParallelOptions) => {
  const { getSwapQuotes, getSwapProviders } = useSwapApi()
  const { client: rpcClient } = useRpcClient()
  const { address, chain } = useWagmi()
  const { chainId } = useEulerAddresses()
  const { buildSimulationStateOverride } = useEulerOperations()

  const quoteCards = ref<SwapQuoteCard[]>([])
  const selectedProvider = ref<string | null>(null)
  const providersCount = ref(0)
  const providersFetchedCount = ref(0)
  const isLoading = ref(false)
  const quoteError = ref<string | null>(null)

  let quoteAbort: AbortController | null = null
  const guard = createRaceGuard()

  const sortedQuoteCards = computed(() =>
    sortQuoteCards(quoteCards.value, options.amountField, options.compare),
  )
  const bestQuote = computed(() => sortedQuoteCards.value[0]?.quote || null)
  const bestAmount = computed(() => {
    const best = sortedQuoteCards.value[0]
    return best ? getQuoteAmount(best.quote, options.amountField) : 0n
  })
  const selectedQuote = computed(() => {
    if (!selectedProvider.value) {
      return null
    }
    const match = quoteCards.value.find(card => card.provider === selectedProvider.value)
    return match?.quote || null
  })
  const effectiveQuote = computed(() => selectedQuote.value || bestQuote.value)
  const statusLabel = computed(() => {
    if (!providersCount.value) {
      return null
    }
    const current = Math.min(providersFetchedCount.value, providersCount.value)
    const total = providersCount.value
    const progress = Math.round((current / total) * 100)
    return current < total
      ? `Fetching quotes ${progress}%`
      : 'Quotes fetched'
  })

  const getQuoteDiffPctFor = (quote: SwapApiQuote) => {
    const card = quoteCards.value.find(item => item.quote === quote)
    const best = sortedQuoteCards.value[0]
    if (!best) return null

    const bestScore = getQuoteCardScore(best, options.compare)
    const score = card ? getQuoteCardScore(card, options.compare) : null
    if (bestScore !== null && score !== null) {
      return getQuoteDiffPct(score, bestScore, options.compare)
    }
    return getQuoteDiffPct(
      Number(getQuoteAmount(quote, options.amountField)),
      Number(getQuoteAmount(best.quote, options.amountField)),
      options.compare,
    )
  }

  const isCowQuote = (provider: string, quote: SwapApiQuote) => {
    const normalizedProvider = provider.toLowerCase()
    return normalizedProvider.includes(COWSWAP_PROVIDER_NAME)
      || quote.route?.some(route => route.providerName.toLowerCase().includes(COWSWAP_PROVIDER_NAME))
  }

  const getQuotePricingToken = (quote: SwapApiQuote) =>
    options.amountField === 'amountIn' ? quote.tokenIn : quote.tokenOut

  const getAmountUsd = async (quote: SwapApiQuote): Promise<number | undefined> => {
    const token = getQuotePricingToken(quote)
    if (!token.address) return undefined
    const amount = getQuoteAmount(quote, options.amountField)
    if (amount <= 0n) return undefined
    return getTokenUsdValue(amount, token.decimals, token.address, null)
  }

  const getGasCostUsd = async (gasCostNative: bigint): Promise<number | undefined> => {
    if (gasCostNative <= 0n) return undefined
    const wrappedNativeAddress = chainId.value ? resolveWrappedNativeAddress(chainId.value) : null
    if (!wrappedNativeAddress) return undefined
    const nativeDecimals = chain.value?.nativeCurrency.decimals ?? 18
    return getTokenUsdValue(gasCostNative, nativeDecimals, wrappedNativeAddress, null)
  }

  const enrichQuoteCard = async (
    provider: string,
    quote: SwapApiQuote,
    params: SwapApiRequestInput,
    gasPricePromise: Promise<bigint | undefined>,
  ): Promise<SwapQuoteCard | null> => {
    const amountUsdPromise = getAmountUsd(quote).catch(() => undefined)

    if (isCowQuote(provider, quote)) {
      return {
        provider,
        quote,
        amountUsd: await amountUsdPromise,
        gasCostNative: 0n,
        gasCostUsd: 0,
      }
    }

    const client = rpcClient.value
    if (!client) {
      return { provider, quote, amountUsd: await amountUsdPromise }
    }

    let gas: bigint
    try {
      if (!options.buildTxPlanForQuote) {
        return { provider, quote, amountUsd: await amountUsdPromise }
      }

      const account = (params.origin || address.value || quote.accountIn) as Address
      const plan = applyOperationGuards(await options.buildTxPlanForQuote(quote, provider))
      const stateOverride = await buildSimulationStateOverride(plan, account)
      const stepsToEstimate = plan.steps.filter(step => step.type !== 'approve' && step.type !== 'permit2-approve')
      gas = 0n
      for (const step of stepsToEstimate) {
        /* eslint-disable @typescript-eslint/no-explicit-any -- TxPlan steps are runtime ABI/data pairs */
        const data = encodeFunctionData({
          abi: step.abi as any,
          functionName: step.functionName as any,
          args: step.args as any,
        })
        gas += await client.estimateGas({
          account,
          to: step.to,
          data,
          value: step.value ?? 0n,
          stateOverride: stateOverride.length ? stateOverride as StateOverride : undefined,
        })
        /* eslint-enable @typescript-eslint/no-explicit-any */
      }
    }
    catch {
      console.warn(`estimateGas for quote ${provider} failed`)
      return null
    }

    const gasPrice = await gasPricePromise
    if (!gasPrice) {
      return { provider, quote, amountUsd: await amountUsdPromise }
    }

    const gasCostNative = gas * gasPrice
    const [amountUsd, gasCostUsd] = await Promise.all([
      amountUsdPromise,
      getGasCostUsd(gasCostNative).catch(() => undefined),
    ])
    return {
      provider,
      quote,
      amountUsd,
      gasCostNative,
      gasCostUsd,
    }
  }

  const reset = () => {
    quoteCards.value = []
    selectedProvider.value = null
    providersCount.value = 0
    providersFetchedCount.value = 0
    quoteError.value = null
    if (quoteAbort) {
      quoteAbort.abort()
      quoteAbort = null
    }
    guard.next()
    isLoading.value = false
  }

  const upsertQuote = (card: SwapQuoteCard) => {
    const { provider } = card
    const next = quoteCards.value.filter(card => card.provider !== provider)
    next.push(card)
    quoteCards.value = sortQuoteCards(next, options.amountField, options.compare)
    if (isLoading.value && next.length > 0) {
      isLoading.value = false
    }
  }

  const requestQuotes = async (
    params: SwapApiRequestInput,
    requestOptions: SwapQuotesRequestOptions = {},
  ) => {
    quoteError.value = null

    if (quoteAbort) {
      quoteAbort.abort()
    }
    const controller = new AbortController()
    quoteAbort = controller
    const gen = guard.next()

    isLoading.value = true
    quoteCards.value = []
    selectedProvider.value = null
    providersFetchedCount.value = 0
    providersCount.value = 0

    try {
      const providers = requestOptions.providers ?? await getSwapProviders({ includeCowSwap: options.includeCowSwap })
      if (guard.isStale(gen)) {
        return
      }
      providersCount.value = providers.length

      if (!providers.length) {
        quoteError.value = 'No swap providers available'
        return
      }

      let rateLimitedCount = 0
      const gasPricePromise = rpcClient.value
        ? rpcClient.value.getGasPrice().catch(() => undefined)
        : Promise.resolve(undefined)

      const fetchProviderQuote = async (provider: string) => {
        try {
          const data = await getSwapQuotes({
            ...params,
            provider,
          }, { signal: controller.signal })

          if (guard.isStale(gen)) {
            return
          }

          const best = pickBestQuote(data, options.amountField, options.compare)
          if (best) {
            const transformed = options.transformQuote ? options.transformQuote(best, provider) : best
            const card = await enrichQuoteCard(provider, transformed, params, gasPricePromise)
            if (guard.isStale(gen) || !card) {
              return
            }
            upsertQuote(card)
          }
        }
        catch (err) {
          if (isAbortError(err)) {
            return
          }
          const axiosErr = err as { response?: { status?: number } }
          if (axiosErr.response?.status === 429) {
            rateLimitedCount += 1
          }
        }
        finally {
          if (!guard.isStale(gen)) {
            providersFetchedCount.value += 1
            if (providersFetchedCount.value >= providersCount.value) {
              isLoading.value = false
              if (!quoteCards.value.length) {
                quoteError.value = rateLimitedCount >= providersCount.value
                  ? 'Rate limited. Please wait a moment and try again.'
                  : (requestOptions.errorMessage || 'Unable to fetch swap quote. Swapping is not available for this asset.')
              }
            }
          }
        }
      }

      providers.forEach((provider) => {
        void fetchProviderQuote(provider)
      })
    }
    catch (err) {
      if (isAbortError(err)) {
        return
      }
      const axiosErr = err as { response?: { status?: number } }
      quoteError.value = axiosErr.response?.status === 429
        ? 'Rate limited. Please wait a moment and try again.'
        : (requestOptions.errorMessage || 'Unable to fetch swap quote. Swapping is not available for this asset.')
      quoteCards.value = []
    }
    finally {
      if (!guard.isStale(gen)) {
        if (providersFetchedCount.value >= providersCount.value) {
          isLoading.value = false
        }
      }
    }
  }

  const selectProvider = (provider: string) => {
    selectedProvider.value = provider
  }

  watch(quoteCards, (next) => {
    if (!next.length) {
      selectedProvider.value = null
      return
    }
    if (
      selectedProvider.value
      && !next.some(card => card.provider === selectedProvider.value)
    ) {
      selectedProvider.value = null
    }
  })

  return {
    quoteCards,
    sortedQuoteCards,
    bestQuote,
    bestAmount,
    selectedProvider,
    selectedQuote,
    effectiveQuote,
    providersCount,
    providersFetchedCount,
    isLoading,
    quoteError,
    statusLabel,
    getQuoteDiffPct: getQuoteDiffPctFor,
    reset,
    requestQuotes,
    selectProvider,
  }
}
