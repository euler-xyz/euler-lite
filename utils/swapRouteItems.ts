import { formatUnits } from 'viem'
import type { SwapApiQuote } from '~/entities/swap'
import { getQuoteCardAmount, type SwapQuoteAmountField, type SwapQuoteCard } from '~/utils/swapQuotes'
import { formatUsdValue } from '~/utils/string-utils'

export type SwapRouteItem = {
  provider: string
  amount: string
  symbol: string
  gasCostLabel?: string
  routeLabel?: string
  badge?: {
    label: string
    tone: 'best' | 'worse'
  }
}

export function buildSwapRouteItems(params: {
  quoteCards: SwapQuoteCard[]
  getQuoteDiffPct: (quote: SwapApiQuote) => number | null
  decimals: number
  symbol: string
  formatAmount: (raw: string) => string
  amountField?: SwapQuoteAmountField
  diffPrefix?: string
  nativeSymbol?: string
  nativeDecimals?: number
}): SwapRouteItem[] {
  const {
    quoteCards,
    getQuoteDiffPct,
    decimals,
    symbol,
    formatAmount,
    amountField = 'amountOut',
    diffPrefix = '-',
    nativeSymbol,
    nativeDecimals = 18,
  } = params

  const bestProvider = quoteCards[0]?.provider
  const formatGasCostLabel = (card: SwapQuoteCard) => {
    if (card.gasCostUsd && card.gasCostUsd > 0) {
      return `Gas ${formatUsdValue(card.gasCostUsd)}`
    }
    if (card.gasCostNative && card.gasCostNative > 0n && nativeSymbol) {
      return `Gas ${formatAmount(formatUnits(card.gasCostNative, nativeDecimals))} ${nativeSymbol}`
    }
    return undefined
  }

  return quoteCards.map((card) => {
    const amount = getQuoteCardAmount(card, amountField)
    const formatted = formatAmount(formatUnits(amount, decimals))
    const diffPct = getQuoteDiffPct(card.quote)
    const badge = card.provider === bestProvider
      ? { label: 'Best', tone: 'best' as const }
      : diffPct !== null
        ? { label: `${diffPrefix}${diffPct.toFixed(2)}%`, tone: 'worse' as const }
        : undefined

    return {
      provider: card.provider,
      amount: formatted,
      symbol,
      gasCostLabel: formatGasCostLabel(card),
      routeLabel: card.quote.route?.length
        ? `via ${card.quote.route.map(r => r.providerName).join(', ')}`
        : '-',
      badge,
    }
  })
}
