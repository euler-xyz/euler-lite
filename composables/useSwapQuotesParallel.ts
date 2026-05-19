import type { Address, PublicClient } from 'viem'
import type { SwapProviderExtraData, SwapQuote, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import type { SwapQuoteInput } from '~/composables/useSwapApi'
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
import { isCowProvider, isCowProviderOrQuote } from '~/entities/cowswap'
import { getTokenUsdValue } from '~/utils/sdk-prices'
import { resolveWrappedNativeAddress } from '~/utils/native-currency'
import { shouldDiscardQuoteOnEstimateGasError } from '~/utils/tx-errors'
import { getEulerSdkFresh } from '~/composables/useEulerSdk'

type SwapQuotesParallelOptions = {
  amountField: SwapQuoteAmountField
  compare: SwapQuoteCompare
  /** Surface CoW Protocol as a quote source (Ethereum mainnet etc.). */
  includeCowSwap?: boolean
  /** Build a TransactionPlan from a quote so the composable can run gas
   *  estimation and discard quotes that fail with swapper/verifier reverts. */
  buildTxPlanForQuote?: (quote: SwapQuote, provider: string) => Promise<TransactionPlan>
}

type SwapQuotesRequestOptions = {
  providers?: string[]
  errorMessage?: string
  /** Per-provider overrides for the SDK's `providerExtraData` field — e.g.
   *  the CoW wrapper type ('openPosition' / 'closePosition' / 'collateralSwap'). */
  providerExtraData?: Partial<Record<string, SwapProviderExtraData>>
  /** Per-provider overrides for individual request fields — e.g. CoW needing
   *  a different `accountIn`/`accountOut` than the EVC batch path. */
  providerParams?: Partial<Record<string, Partial<SwapQuoteInput>>>
}

export const useSwapQuotesParallel = (options: SwapQuotesParallelOptions) => {
  const { getSwapQuotes, getSwapProviders } = useSwapApi()
  const { client: rpcClient } = useRpcClient()
  const { address, chain } = useWagmi()
  const { chainId } = useEulerAddresses()

  const quoteCards = ref<SwapQuoteCard[]>([])
  const selectedProvider = ref<string | null>(null)
  const providersCount = ref(0)
  const providersFetchedCount = ref(0)
  const isLoading = ref(false)
  const quoteError = ref<string | null>(null)

  let quoteAbort: AbortController | null = null
  // Remembered across re-fetches so the user's manual route choice survives
  // a quote refresh even if the provider list temporarily shrinks.
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
  const findCardForQuote = (quote: SwapQuote): SwapQuoteCard | undefined => {
    const byRef = quoteCards.value.find(c => c.quote === quote)
    if (byRef) return byRef
    return quoteCards.value.find(c =>
      c.quote.amountIn === quote.amountIn
      && c.quote.amountOut === quote.amountOut
      && c.quote.tokenIn?.address === quote.tokenIn?.address
      && c.quote.tokenOut?.address === quote.tokenOut?.address,
    )
  }

  const getQuoteDiffPctFor = (quote: SwapQuote) => {
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

  const getQuotePricingToken = (quote: SwapQuote) =>
    options.amountField === 'amountIn' ? quote.tokenIn : quote.tokenOut

  const getAmountUsd = async (quote: SwapQuote): Promise<number | undefined> => {
    const token = getQuotePricingToken(quote)
    if (!token?.address) return undefined
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

  // Estimate gas via the SDK's executionService.estimateGasForTransactionPlan.
  // CoW plans are intent-based and have no on-chain batch — short-circuit
  // before calling the SDK helper (which asserts no CoW items).
  const estimateTxPlanGas = async (plan: TransactionPlan, account: Address): Promise<bigint> => {
    if (!chainId.value) throw new Error('estimateTxPlanGas: no chainId')
    const sdk = await getEulerSdkFresh()
    return sdk.executionService.estimateGasForTransactionPlan(chainId.value, account, plan)
  }

  const enrichQuoteCard = async (
    provider: string,
    quote: SwapQuote,
    params: SwapQuoteInput,
    client: PublicClient | null,
    gasPricePromise: Promise<bigint | undefined>,
  ): Promise<SwapQuoteCard | null> => {
    const amountUsdPromise = getAmountUsd(quote).catch(() => undefined)

    // CoW intents settle off-chain — gas cost is genuinely zero from the
    // user's perspective. Mark the card so the route selector renders
    // "Gasless" and the ranking treats it as a real zero rather than a
    // missing estimate.
    if (isCowProviderOrQuote(provider, quote)) {
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
    params: SwapQuoteInput,
    requestOptions: SwapQuotesRequestOptions,
  ) => {
    const normalizedProvider = provider.toLowerCase()
    return requestOptions.providerExtraData?.[provider]
      ?? requestOptions.providerExtraData?.[normalizedProvider]
      ?? (isCowProvider(provider) ? params.providerExtraData : undefined)
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
    params: SwapQuoteInput,
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
          const data = await getSwapQuotes({
            ...providerParams,
            provider,
            providerExtraData: getProviderExtraData(provider, providerParams, requestOptions),
          }, { signal: controller.signal })

          if (guard.isStale(gen)) {
            return
          }

          const best = pickBestQuote(data, options.amountField, options.compare)
          if (best) {
            const card = await enrichQuoteCard(provider, best, providerParams, client, gasPricePromise)
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
