import { formatUnits } from 'viem'
import type { SwapApiQuote } from '~/entities/swap'
import { SwapperMode } from '~/entities/swap'
import { getSwapInputAmount } from '~/composables/useEulerOperations/swaps/verify'
import { trimTrailingZeros } from '~/utils/string-utils'

export const getRepaySwapReviewInputAmount = ({
  amount,
  quote,
  sourceDecimals,
  swapperMode,
}: {
  amount: string
  quote?: SwapApiQuote | null
  sourceDecimals: bigint | number
  swapperMode: SwapperMode
}): string => {
  if (swapperMode === SwapperMode.TARGET_DEBT && quote) {
    const inputAmount = getSwapInputAmount(quote, swapperMode)
    if (inputAmount > 0n) {
      return trimTrailingZeros(formatUnits(inputAmount, Number(sourceDecimals)))
    }
  }

  return amount || '0'
}
