import { SwapperMode, type SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { formatUnits } from 'viem'
import type { StepDecodingContext } from '~/utils/stepDecoding'
import { getSwapInputAmount } from '~/utils/swapQuotes'

/** Capture quote presentation before the form resets; verifier amounts remain execution constraints. */
export const captureSwapReview = (
  quote: SwapQuote | null | undefined,
  mode: SwapperMode,
  targetDebtAmount?: string,
): Pick<StepDecodingContext, 'swapFromAsset' | 'swapFromAmount' | 'swapToAsset' | 'swapToAmount' | 'swapMode'> => {
  if (!quote) return {}
  return {
    swapFromAsset: { ...quote.tokenIn },
    swapFromAmount: formatUnits(getSwapInputAmount(quote, mode), Number(quote.tokenIn.decimals)),
    swapToAsset: { ...quote.tokenOut },
    swapToAmount: mode === SwapperMode.TARGET_DEBT && targetDebtAmount !== undefined
      ? targetDebtAmount
      : formatUnits(BigInt(quote.amountOut), Number(quote.tokenOut.decimals)),
    swapMode: mode,
  }
}
