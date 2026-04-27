import { type SwapApiQuote, SwapperMode } from '~/entities/swap'
import { BPS_BASE } from '~/entities/tuning-constants'

export type SwapQuoteAmountField = 'amountIn' | 'amountOut'
export type SwapQuoteCompare = 'max' | 'min'

export type SwapQuoteCard = {
  provider: string
  quote: SwapApiQuote
  amountUsd?: number
  gasCostNative?: bigint
  gasCostUsd?: number
  /** Route is genuinely gas-free (e.g. CoW intents). Distinguishes
   *  "gas is known to be 0" from "gas estimate unavailable". */
  isGasless?: boolean
}

/** Whether the gas cost on a card is trustworthy (known-zero for gasless
 *  routes, or a positive estimate). Cards whose sim failed or whose gas
 *  price was unavailable return false. */
export const hasKnownGas = (card: SwapQuoteCard): boolean =>
  !!card.isGasless || (card.gasCostUsd !== undefined && card.gasCostUsd > 0)

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

/**
 * Compare-aware score for ranking AND display.
 * - max mode (swap output, multiply, borrow): `amountUsd − gas`. Net value
 *   you receive; gas eats your proceeds. Can go negative if gas > output.
 * - min mode (target-debt repay): `amountUsd + gas`. Total you spend; gas
 *   adds to the cost of repayment.
 */
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
