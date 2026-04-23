import { formatUnits } from 'viem'
import type { SwapApiQuote } from '~/entities/swap'
import {
  getQuoteCardAmount,
  getQuoteCardScore,
  hasKnownGas,
  type SwapQuoteAmountField,
  type SwapQuoteCard,
  type SwapQuoteCompare,
} from '~/utils/swapQuotes'
import { formatUsdValue } from '~/utils/string-utils'

export type SwapRouteItem = {
  provider: string
  amount: string
  symbol: string
  gasCostLabel?: string
  netUsdLabel?: string
  routeLabel?: string
  isGasless?: boolean
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
  compare?: SwapQuoteCompare
  diffPrefix?: string
}): SwapRouteItem[] {
  const {
    quoteCards,
    getQuoteDiffPct,
    decimals,
    symbol,
    formatAmount,
    amountField = 'amountOut',
    compare = 'max',
    diffPrefix = '-',
  } = params

  const bestProvider = quoteCards[0]?.provider

  const formatGasCostLabel = (card: SwapQuoteCard) => {
    if (card.gasCostUsd && card.gasCostUsd > 0) {
      return formatUsdValue(card.gasCostUsd)
    }
    return undefined
  }

  // Max mode = "net output after gas" (subtracts). Min mode = "total spend
  // including gas" (adds). Same score, different framing.
  const netSuffix = compare === 'max' ? 'after gas' : 'including gas'
  const formatNetUsdLabel = (card: SwapQuoteCard) => {
    const score = getQuoteCardScore(card, compare)
    if (score === null || !hasKnownGas(card)) return undefined
    return `≈ ${formatUsdValue(score)} ${netSuffix}`
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
      netUsdLabel: formatNetUsdLabel(card),
      routeLabel: card.quote.route?.length
        ? `via ${card.quote.route.map(r => r.providerName).join(', ')}`
        : '-',
      isGasless: card.isGasless,
      badge,
    }
  })
}
