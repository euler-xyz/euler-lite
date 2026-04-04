import type { SwapApiQuote } from '~/entities/swap'
import type { SwapApiRequestInput } from '~/composables/useSwapApi'
import {
  getQuoteAmount,
  getQuoteDiffPct,
  pickBestQuote,
  sortQuoteCards,
  type SwapQuoteAmountField,
  type SwapQuoteCard,
  type SwapQuoteCompare,
} from '~/utils/swapQuotes'
import { createRaceGuard } from '~/utils/race-guard'
import { isAbortError } from '~/utils/errorHandling'

type SwapQuotesParallelOptions = {
  amountField: SwapQuoteAmountField
  compare: SwapQuoteCompare
  transformQuote?: (quote: SwapApiQuote, provider: string) => SwapApiQuote
  includeCowSwap?: boolean
}

type SwapQuotesRequestOptions = {
  logContext?: Record<string, unknown>
  providers?: string[]
  errorMessage?: string
}

export const useSwapQuotesParallel = (options: SwapQuotesParallelOptions) => {
  const { getSwapQuotes, getSwapProviders, logSwapFailure } = useSwapApi()

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
  const bestAmount = computed(() => getQuoteAmount(bestQuote.value, options.amountField))
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
    const best = bestAmount.value
    const amount = getQuoteAmount(quote, options.amountField)
    return getQuoteDiffPct(amount, best, options.compare)
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

  const upsertQuote = (provider: string, quote: SwapApiQuote) => {
    const next = quoteCards.value.filter(card => card.provider !== provider)
    next.push({ provider, quote })
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
            upsertQuote(provider, transformed)
          }
        }
        catch (err) {
          if (isAbortError(err)) {
            return
          }
          const axiosErr = err as { response?: { status?: number }, message?: string }
          if (axiosErr.response?.status === 429) {
            rateLimitedCount += 1
          }
          if (requestOptions.logContext) {
            logSwapFailure({
              reason: axiosErr.message || 'Unknown error',
              provider,
              ...requestOptions.logContext,
            })
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
