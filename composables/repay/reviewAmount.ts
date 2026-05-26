import { formatUnits } from 'viem'
import type { SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { getSwapInputAmount } from '~/utils/swapQuotes'
import { trimTrailingZeros } from '~/utils/string-utils'

export const getRepaySwapReviewInputAmount = ({
  amount,
  quote,
  sourceDecimals,
  swapperMode,
}: {
  amount: string
  quote?: SwapQuote | null
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
