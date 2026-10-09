import type { Ref } from 'vue'
import type { PluginPrefetchData, SwapQuote, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { useSwapQuotesParallel, type SwapQuoteIncludeCowSwap, type SwapQuotePlanAccount, type SwapQuotePlanContext } from '~/composables/useSwapQuotesParallel'
import type { OperationIntent } from '~/features/reviewed-execution/domain/intents'

/**
 * Wraps two useSwapQuotesParallel instances (exact-in + target-debt) and provides
 * direction-aware computed properties. Used by both collateral-swap and savings tabs.
 */
export const useSwapRepayQuotes = (options: {
  direction: Ref<SwapperMode>
  includeCowSwap?: SwapQuoteIncludeCowSwap
  buildTxPlanForQuote: (quote: SwapQuote, provider: string, context: SwapQuotePlanContext) => Promise<TransactionPlan>
  createIntentsForQuote?: (quote: SwapQuote, provider: string) => readonly OperationIntent[]
  buildGasEstimatePlan?: (candidatePlan: TransactionPlan) => Promise<TransactionPlan> | TransactionPlan
  prefetchPluginData?: (
    plan: TransactionPlan,
    account: SwapQuotePlanAccount,
    intents: readonly OperationIntent[] | undefined,
  ) => Promise<PluginPrefetchData>
  getPlanAccount?: () => SwapQuotePlanAccount | undefined
}) => {
  const { direction, includeCowSwap, buildTxPlanForQuote, createIntentsForQuote, buildGasEstimatePlan, prefetchPluginData, getPlanAccount } = options

  const exactInQuotes = useSwapQuotesParallel({ amountField: 'amountOut', compare: 'max', includeCowSwap, buildTxPlanForQuote, createIntentsForQuote, buildGasEstimatePlan, prefetchPluginData, getPlanAccount })
  const targetDebtQuotes = useSwapQuotesParallel({ amountField: 'amountIn', compare: 'min', includeCowSwap, buildTxPlanForQuote, createIntentsForQuote, buildGasEstimatePlan, prefetchPluginData, getPlanAccount })

  const isExactIn = computed(() => direction.value === SwapperMode.EXACT_IN)

  const sortedQuoteCards = computed(() => isExactIn.value
    ? exactInQuotes.sortedQuoteCards.value
    : targetDebtQuotes.sortedQuoteCards.value)

  const selectedProvider = computed(() => isExactIn.value
    ? exactInQuotes.selectedProvider.value
    : targetDebtQuotes.selectedProvider.value)

  const selectedQuote = computed(() => isExactIn.value
    ? exactInQuotes.selectedQuote.value
    : targetDebtQuotes.selectedQuote.value)

  const selectedQuoteCard = computed(() => isExactIn.value
    ? exactInQuotes.selectedQuoteCard.value
    : targetDebtQuotes.selectedQuoteCard.value)

  const effectiveQuote = computed(() => isExactIn.value
    ? exactInQuotes.effectiveQuote.value
    : targetDebtQuotes.effectiveQuote.value)

  const effectiveQuoteFetchedAt = computed(() => isExactIn.value
    ? exactInQuotes.effectiveQuoteFetchedAt.value
    : targetDebtQuotes.effectiveQuoteFetchedAt.value)

  const providersCount = computed(() => isExactIn.value
    ? exactInQuotes.providersCount.value
    : targetDebtQuotes.providersCount.value)

  const isLoading = computed(() => isExactIn.value
    ? exactInQuotes.isLoading.value
    : targetDebtQuotes.isLoading.value)

  const quoteError = computed(() => isExactIn.value
    ? exactInQuotes.quoteError.value
    : targetDebtQuotes.quoteError.value)

  const statusLabel = computed(() => isExactIn.value
    ? exactInQuotes.statusLabel.value
    : targetDebtQuotes.statusLabel.value)

  const quote = computed(() => effectiveQuote.value || null)

  const selectProvider = (provider: string) => {
    if (isExactIn.value) {
      exactInQuotes.selectProvider(provider)
    }
    else {
      targetDebtQuotes.selectProvider(provider)
    }
  }

  const reset = () => {
    exactInQuotes.reset()
    targetDebtQuotes.reset()
  }

  const getQuoteDiffPct = (q: Parameters<typeof exactInQuotes.getQuoteDiffPct>[0]) => {
    return (isExactIn.value ? exactInQuotes.getQuoteDiffPct : targetDebtQuotes.getQuoteDiffPct)(q)
  }

  return {
    exactInQuotes,
    targetDebtQuotes,
    sortedQuoteCards,
    selectedProvider,
    selectedQuote,
    selectedQuoteCard,
    effectiveQuote,
    effectiveQuoteFetchedAt,
    providersCount,
    isLoading,
    quoteError,
    statusLabel,
    quote,
    selectProvider,
    reset,
    getQuoteDiffPct,
  }
}
