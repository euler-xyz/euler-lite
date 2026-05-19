import { formatUnits } from 'viem'
import type { SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { getQuoteAmount, type SwapQuoteAmountField } from '~/utils/swapQuotes'

export type SwapRouteItem = {
  provider: string
  amount: string
  symbol: string
  routeLabel?: string
  badge?: {
    label: string
    tone: 'best' | 'worse'
  }
}

interface QuoteCard {
  provider: string
  quote: SwapQuote
}

export function buildSwapRouteItems(params: {
  quoteCards: QuoteCard[]
  getQuoteDiffPct: (quote: SwapQuote) => number | null
  decimals: number
  symbol: string
  formatAmount: (raw: string) => string
  amountField?: SwapQuoteAmountField
  diffPrefix?: string
}): SwapRouteItem[] {
  const {
    quoteCards,
    getQuoteDiffPct,
    decimals,
    symbol,
    formatAmount,
    amountField = 'amountOut',
    diffPrefix = '-',
  } = params

  const bestProvider = quoteCards[0]?.provider

  return quoteCards.map((card) => {
    const amount = getQuoteAmount(card.quote, amountField)
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
      routeLabel: card.quote.route?.length
        ? `via ${card.quote.route.map(r => r.providerName).join(', ')}`
        : '-',
      badge,
    }
  })
}
