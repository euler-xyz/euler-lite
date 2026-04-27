import { type SwapApiQuote, SwapperMode } from '~/entities/swap'
import { BPS_BASE } from '~/entities/tuning-constants'

export type SwapQuoteAmountField = 'amountIn' | 'amountOut'
export type SwapQuoteCompare = 'max' | 'min'

export type SwapQuoteCard = {
  provider: string
  quote: SwapApiQuote
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

const parseRequiredBigInt = (value?: string | number | bigint | null) => {
  if (value === null || value === undefined) {
    return null
  }
  try {
    return BigInt(value)
  }
  catch {
    return null
  }
}

export const computeQuoteSlippage = (
  quote: SwapApiQuote | null | undefined,
  swapperMode = SwapperMode.EXACT_IN,
) => {
  if (!quote) {
    return null
  }

  if (swapperMode === SwapperMode.TARGET_DEBT) {
    const amountIn = getQuoteAmount(quote, 'amountIn')
    const amountInMax = parseRequiredBigInt(quote.amountInMax)
    if (amountIn <= 0n || amountInMax === null || amountInMax < amountIn) {
      return null
    }
    const diffBps = ((amountInMax - amountIn) * BPS_BASE) / amountIn
    return Number(diffBps) / 100
  }

  const amountOut = getQuoteAmount(quote, 'amountOut')
  const amountOutMin = parseRequiredBigInt(quote.amountOutMin)
  if (amountOut <= 0n || amountOutMin === null || amountOutMin > amountOut) {
    return null
  }
  const diffBps = ((amountOut - amountOutMin) * BPS_BASE) / amountOut
  return Number(diffBps) / 100
}
