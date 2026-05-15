import type { Address, PublicClient } from 'viem'
import type { SwapApiProviderExtraData, SwapApiQuote } from '~/entities/swap'
import type { SwapApiRequestInput } from '~/composables/useSwapApi'
import type { TxPlan } from '~/entities/txPlan'
import {
  getQuoteAmount,
  getQuoteCardScore,
  getQuoteDiffPct,
  hasKnownGas,
  pickBestQuote,
  sortQuoteCards,
  type SwapQuoteAmountField,
  type SwapQuoteCard,
  type SwapQuoteCompare,
} from '~/utils/swapQuotes'
import { createRaceGuard } from '~/utils/race-guard'
import { isAbortError, logWarn } from '~/utils/errorHandling'
import { isCowProvider } from '~/entities/cowswap'
import { getTokenUsdValue } from '~/services/pricing/priceProvider'
import { resolveWrappedNativeAddress } from '~/utils/native-currency'
import { shouldDiscardQuoteOnEstimateGasError } from '~/utils/tx-errors'

type SwapQuotesParallelOptions = {
  amountField: SwapQuoteAmountField
  compare: SwapQuoteCompare
  includeCowSwap?: boolean
  buildTxPlanForQuote?: (quote: SwapApiQuote, provider: string) => Promise<TxPlan>
}

type SwapQuotesRequestOptions = {
  providers?: string[]
  errorMessage?: string
  providerExtraData?: Partial<Record<string, SwapApiProviderExtraData>>
  providerParams?: Partial<Record<string, Partial<SwapApiRequestInput>>>
}

export const useSwapQuotesParallel = (options: SwapQuotesParallelOptions) => {
  const { getSwapQuotes, getSwapProviders } = useSwapApi()
  const { client: rpcClient } = useRpcClient()
  const { address, chain } = useWagmi()
  const { chainId } = useEulerAddresses()
  const { estimateTxPlanGas } = useEulerOperations()

  const quoteCards = ref<SwapQuoteCard[]>([])
  const selectedProvider = ref<string | null>(null)
  const providersCount = ref(0)
  const providersFetchedCount = ref(0)
  const isLoading = ref(false)
  const quoteError = ref<string | null>(null)

  let quoteAbort: AbortController | null = null
  let userSelectedProvider: string | null = null
  const guard = createRaceGuard()

  const sortedQuoteCards = computed(() =>
    sortQuoteCards(quoteCards.value, options.amountField, options.compare),
  )
  const bestQuoteCard = computed(() => sortedQuoteCards.value[0] || null)
  const bestQuote = computed(() => bestQuoteCard.value?.quote || null)
  const bestQuoteFetchedAt = computed(() => bestQuoteCard.value?.fetchedAt || null)
  const bestAmount = computed(() => getQuoteAmount(bestQuote.value, options.amountField))
  const selectedQuoteCard = computed(() => {
    if (!selectedProvider.value) {
      return null
    }
    const match = quoteCards.value.find(card => card.provider === selectedProvider.value)
    return match || null
  })
  const selectedQuote = computed(() => selectedQuoteCard.value?.quote || null)
  const selectedQuoteFetchedAt = computed(() => selectedQuoteCard.value?.fetchedAt || null)
  const effectiveQuoteCard = computed<SwapQuoteCard | null>((previous) => {
    const next = selectedQuoteCard.value || bestQuoteCard.value
    if (
      previous
      && next
      && previous.provider === next.provider
      && previous.quote === next.quote
    ) {
      return previous
    }
    return next
  })
  const effectiveQuote = computed(() => effectiveQuoteCard.value?.quote || null)
  const effectiveProvider = computed(() => effectiveQuoteCard.value?.provider || null)
  const effectiveQuoteFetchedAt = computed(() => effectiveQuoteCard.value?.fetchedAt || null)
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

  // Locate the card corresponding to a quote. Uses referential identity first
  // (fast path for untransformed quotes) and falls back to matching amount /
  // token fields so transformed quotes (e.g. CoW share→underlying) still hit.
  const findCardForQuote = (quote: SwapApiQuote): SwapQuoteCard | undefined => {
    const byRef = quoteCards.value.find(c => c.quote === quote)
    if (byRef) return byRef
    return quoteCards.value.find(c =>
      c.quote.amountIn === quote.amountIn
      && c.quote.amountOut === quote.amountOut
      && c.quote.tokenIn?.address === quote.tokenIn?.address
      && c.quote.tokenOut?.address === quote.tokenOut?.address,
    )
  }

  const getQuoteDiffPctFor = (quote: SwapApiQuote) => {
    const best = sortedQuoteCards.value[0]
    if (!best) return null

    // USD-score diff is only meaningful when BOTH quotes have trustworthy gas
    // (gasless route OR sim succeeded with a positive estimate). Mixing a
    // known-gas score against a sim-failed zero-gas score is apples-to-oranges.
    // Fall through to raw-amount diff for degenerate cases.
    const card = findCardForQuote(quote)
    if (card && hasKnownGas(best) && hasKnownGas(card)) {
      const bestScore = getQuoteCardScore(best, options.compare)
      const score = getQuoteCardScore(card, options.compare)
      if (bestScore !== null && score !== null) {
        const usdDiff = getQuoteDiffPct(score, bestScore, options.compare)
        if (usdDiff !== null) return usdDiff
      }
    }
    return getQuoteDiffPct(
      Number(getQuoteAmount(quote, options.amountField)),
      Number(getQuoteAmount(best.quote, options.amountField)),
      options.compare,
    )
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
    client: PublicClient | null,
    gasPricePromise: Promise<bigint | undefined>,
  ): Promise<SwapQuoteCard | null> => {
    const amountUsdPromise = getAmountUsd(quote).catch(() => undefined)

    if (isCowProvider(provider)) {
      return {
        provider,
        quote,
        amountUsd: await amountUsdPromise,
        gasCostNative: 0n,
        gasCostUsd: 0,
        isGasless: true,
      }
    }

    if (!client || !options.buildTxPlanForQuote) {
      return { provider, quote, amountUsd: await amountUsdPromise }
    }

    let gas: bigint
    try {
      const account = (params.origin || address.value || quote.accountIn) as Address
      const plan = await options.buildTxPlanForQuote(quote, provider)
      gas = await estimateTxPlanGas(plan, account)
    }
    catch (err) {
      if (shouldDiscardQuoteOnEstimateGasError(err)) {
        logWarn('useSwapQuotesParallel/estimateGas', new Error(`quote simulation discarded for ${provider}`))
        return null
      }
      logWarn('useSwapQuotesParallel/estimateGas', err)
      return {
        provider,
        quote,
        amountUsd: await amountUsdPromise,
        gasCostNative: 0n,
        gasCostUsd: 0,
      }
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
    userSelectedProvider = null
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
    const next = quoteCards.value.filter(existing => existing.provider !== provider)
    next.push({ ...card, fetchedAt: card.fetchedAt ?? Date.now() })
    quoteCards.value = sortQuoteCards(next, options.amountField, options.compare)
    if (isLoading.value && next.length > 0) {
      isLoading.value = false
    }
  }

  const getProviderExtraData = (
    provider: string,
    params: SwapApiRequestInput,
    requestOptions: SwapQuotesRequestOptions,
  ) => {
    const normalizedProvider = provider.toLowerCase()
    return requestOptions.providerExtraData?.[provider]
      ?? requestOptions.providerExtraData?.[normalizedProvider]
      ?? (isCowProvider(provider) ? params.providerExtraData : undefined)
  }

  const bindQuoteRequestMetadata = (
    provider: string,
    quote: SwapApiQuote,
    params: SwapApiRequestInput,
    providerExtraData: SwapApiProviderExtraData | undefined,
  ): SwapApiQuote => {
    if (!isCowProvider(provider) || !providerExtraData) return quote

    return {
      ...quote,
      providerData: {
        ...quote.providerData,
        appData: providerExtraData.appData,
        appDataDeadline: providerExtraData.appDataDeadline,
        requestAmount: params.amount?.toString(),
      },
    }
  }

  const getProviderParams = (
    provider: string,
    requestOptions: SwapQuotesRequestOptions,
  ) => {
    const normalizedProvider = provider.toLowerCase()
    return requestOptions.providerParams?.[provider]
      ?? requestOptions.providerParams?.[normalizedProvider]
      ?? {}
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
    // Preserve user's manual selection — it will be validated against
    // new results by the watch(quoteCards) handler below.
    const preservedProvider = userSelectedProvider
    selectedProvider.value = null
    userSelectedProvider = preservedProvider
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
      const client = rpcClient.value
      // Prefer an EIP-1559 wallet-style fee cap: baseFee * 2 + tip.
      // Falls back to legacy eth_gasPrice for non-1559 chains.
      const fetchGasPrice = async (): Promise<bigint | undefined> => {
        if (!client) return undefined
        try {
          const [fees, block] = await Promise.all([
            client.estimateFeesPerGas(),
            client.getBlock(),
          ])

          if ('maxFeePerGas' in fees) {
            return typeof block.baseFeePerGas === 'bigint'
              ? block.baseFeePerGas * 2n + fees.maxPriorityFeePerGas
              : fees.maxFeePerGas
          }
          return (fees as { gasPrice: bigint }).gasPrice
        }
        catch {
          return client.getGasPrice().catch(() => undefined)
        }
      }
      const gasPricePromise = fetchGasPrice()

      const fetchProviderQuote = async (provider: string) => {
        try {
          const providerParams = {
            ...params,
            ...getProviderParams(provider, requestOptions),
          }
          const providerExtraData = getProviderExtraData(provider, providerParams, requestOptions)
          const data = await getSwapQuotes({
            ...providerParams,
            provider,
            providerExtraData,
          }, { signal: controller.signal })

          if (guard.isStale(gen)) {
            return
          }

          const best = pickBestQuote(data, options.amountField, options.compare)
          if (best) {
            const boundQuote = bindQuoteRequestMetadata(provider, best, providerParams, providerExtraData)
            const card = await enrichQuoteCard(provider, boundQuote, providerParams, client, gasPricePromise)
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
    if (selectedProvider.value === provider) {
      return
    }
    selectedProvider.value = provider
    userSelectedProvider = provider
  }

  watch(quoteCards, (next) => {
    if (!next.length) {
      selectedProvider.value = null
      return
    }
    // Restore user's manual selection if the provider reappears after a re-fetch
    if (!selectedProvider.value && userSelectedProvider && next.some(card => card.provider === userSelectedProvider)) {
      selectedProvider.value = userSelectedProvider
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
    bestQuoteFetchedAt,
    bestAmount,
    selectedProvider,
    selectedQuote,
    selectedQuoteFetchedAt,
    effectiveQuote,
    effectiveProvider,
    effectiveQuoteFetchedAt,
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
