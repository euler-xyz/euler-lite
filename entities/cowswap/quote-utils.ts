import { COWSWAP_MIN_BUY_AMOUNT } from './constants'

const parsePositiveBigInt = (value?: string): bigint | undefined => {
  if (!value) return undefined
  try {
    const parsed = BigInt(value)
    return parsed > 0n ? parsed : undefined
  }
  catch {
    return undefined
  }
}

export const deriveCowSwapBuyAmountFromQuote = (
  quote?: { amountOutMin?: string, amountOut?: string },
): bigint =>
  parsePositiveBigInt(quote?.amountOutMin)
  ?? parsePositiveBigInt(quote?.amountOut)
  ?? COWSWAP_MIN_BUY_AMOUNT
