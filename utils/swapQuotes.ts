import type { SwapApiQuote } from '~/entities/swap'

export type SwapQuoteAmountField = 'amountIn' | 'amountOut'
export type SwapQuoteCompare = 'max' | 'min'

export type SwapQuoteCard = {
  provider: string
  quote: SwapApiQuote
  amountUsd?: number
  gasCostNative?: bigint
  gasCostUsd?: number
}

const parseBigInt = (value?: string | number | bigint | null) => {
  try {
    return BigInt(value ?? 0)
  }
  catch {
    return 0n
  }
}

export const getQuoteAmount = (
  quote: SwapApiQuote | null | undefined,
  field: SwapQuoteAmountField,
) => {
  if (!quote) {
    return 0n
  }
  return parseBigInt(quote[field])
}

export const getQuoteCardAmount = (
  card: SwapQuoteCard,
  field: SwapQuoteAmountField,
) => getQuoteAmount(card.quote, field)

export const getQuoteCardScore = (
  card: SwapQuoteCard,
  compare: SwapQuoteCompare,
): number | null => {
  if (card.amountUsd === undefined) return null
  const gas = card.gasCostUsd ?? 0
  return compare === 'max' ? card.amountUsd - gas : card.amountUsd + gas
}

export const sortQuoteCards = (
  cards: SwapQuoteCard[],
  field: SwapQuoteAmountField,
  compare: SwapQuoteCompare,
) => {
  return [...cards].sort((first, second) => {
    const scoreA = getQuoteCardScore(first, compare)
    const scoreB = getQuoteCardScore(second, compare)
    if (scoreA !== null && scoreB !== null) {
      if (scoreA === scoreB) return 0
      if (compare === 'max') return scoreB > scoreA ? 1 : -1
      return scoreB > scoreA ? -1 : 1
    }
    if (scoreA !== null) return -1
    if (scoreB !== null) return 1
    const amountA = getQuoteAmount(first.quote, field)
    const amountB = getQuoteAmount(second.quote, field)
    if (amountA === amountB) return 0
    if (compare === 'max') return amountB > amountA ? 1 : -1
    return amountB > amountA ? -1 : 1
  })
}

export const pickBestQuote = (
  quotes: SwapApiQuote[],
  field: SwapQuoteAmountField,
  compare: SwapQuoteCompare,
) => {
  return quotes.reduce<SwapApiQuote | null>((current, quote) => {
    if (!current) {
      return quote
    }
    const currentAmount = getQuoteAmount(current, field)
    const nextAmount = getQuoteAmount(quote, field)
    if (compare === 'max') {
      return nextAmount > currentAmount ? quote : current
    }
    return nextAmount < currentAmount ? quote : current
  }, null)
}

export const getQuoteDiffPct = (
  quoteAmount: number,
  bestAmount: number,
  compare: SwapQuoteCompare,
) => {
  if (bestAmount <= 0 || quoteAmount <= 0 || quoteAmount === bestAmount) {
    return null
  }
  const diff = compare === 'max'
    ? bestAmount - quoteAmount
    : quoteAmount - bestAmount
  if (diff <= 0) {
    return null
  }
  return (diff / bestAmount) * 100
}
