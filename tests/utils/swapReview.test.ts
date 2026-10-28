import { describe, expect, it } from 'vitest'
import { SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { captureSwapReview } from '~/utils/swapReview'
import { makeSwapQuote } from '../reviewed-execution/swap-quote.test-fixture'

const quoteFixture = () => ({
  ...makeSwapQuote(),
  amountIn: '100000000000000000000',
  amountInMax: '100500000000000000000',
  amountOut: '99000000',
  amountOutMin: '98765432',
  tokenOut: { ...makeSwapQuote().tokenOut, decimals: 6 },
})

describe('captureSwapReview', () => {
  it('captures the expected output using token decimals without modifying the quote or verifier', () => {
    const quote = quoteFixture()
    const original = structuredClone(quote)
    const review = captureSwapReview(quote, SwapperMode.EXACT_IN)
    expect(review).toMatchObject({ swapFromAmount: '100', swapToAmount: '99', swapMode: SwapperMode.EXACT_IN })
    expect(quote).toEqual(original)
    quote.amountOut = '0'
    quote.tokenOut.symbol = 'CHANGED'
    expect(review.swapToAmount).toBe('99')
    expect(review.swapToAsset?.symbol).toBe(original.tokenOut.symbol)
  })

  it('uses the requested repayment and maximum input for target-debt review', () => {
    expect(captureSwapReview(quoteFixture(), SwapperMode.TARGET_DEBT, '98.5')).toMatchObject({
      swapFromAmount: '100.5', swapToAmount: '98.5', swapMode: SwapperMode.TARGET_DEBT,
    })
  })

  it('preserves exact-output mode and maximum input', () => {
    expect(captureSwapReview(quoteFixture(), SwapperMode.EXACT_OUT)).toMatchObject({
      swapFromAmount: '100.5', swapToAmount: '99', swapMode: SwapperMode.EXACT_OUT,
    })
  })

  it('leaves same-asset operations without swap metadata', () => {
    expect(captureSwapReview(undefined, SwapperMode.EXACT_IN)).toEqual({})
  })
})
