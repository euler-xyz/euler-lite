import { SwapperMode, type SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { BPS_BASE } from '~/entities/tuning-constants'

export type SwapQuoteAmountField = 'amountIn' | 'amountOut'
export type SwapQuoteCompare = 'max' | 'min'

export type SwapQuoteCard = {
  provider: string
  quote: SwapQuote
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
  quote: SwapQuote | null | undefined,
  field: SwapQuoteAmountField,
) => {
  if (!quote) {
    return 0n
  }
  return parseBigInt(quote[field])
}

export const getSwapInputAmount = (quote: SwapQuote, swapperMode: SwapperMode) => {
  const amountIn = parseBigInt(quote.amountIn)
  const amountInMax = parseBigInt(quote.amountInMax)
  if (swapperMode === SwapperMode.EXACT_IN) return amountIn
  return amountInMax > 0n ? amountInMax : amountIn
}

export const sortQuoteCards = (
  cards: SwapQuoteCard[],
  field: SwapQuoteAmountField,
  compare: SwapQuoteCompare,
) => {
  return [...cards].sort((first, second) => {
    const amountA = getQuoteAmount(first.quote, field)
    const amountB = getQuoteAmount(second.quote, field)
    if (amountA === amountB) {
      return 0
    }
    if (compare === 'max') {
      return amountB > amountA ? 1 : -1
    }
    return amountB > amountA ? -1 : 1
  })
}

export const pickBestQuote = (
  quotes: SwapQuote[],
  field: SwapQuoteAmountField,
  compare: SwapQuoteCompare,
) => {
  return quotes.reduce<SwapQuote | null>((current, quote) => {
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
  quoteAmount: bigint,
  bestAmount: bigint,
  compare: SwapQuoteCompare,
) => {
  if (bestAmount <= 0n || quoteAmount <= 0n || quoteAmount === bestAmount) {
    return null
  }
  const diff = compare === 'max'
    ? bestAmount - quoteAmount
    : quoteAmount - bestAmount
  if (diff <= 0n) {
    return null
  }
  const diffBps = (diff * BPS_BASE) / bestAmount
  return Number(diffBps) / 100
}
