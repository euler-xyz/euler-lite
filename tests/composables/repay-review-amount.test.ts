import { describe, expect, it } from 'vitest'
import type { SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { SwapperMode } from '@eulerxyz/euler-v2-sdk'
import { getRepaySwapReviewInputAmount } from '~/composables/repay/reviewAmount'

const makeQuote = (overrides: Partial<SwapQuote> = {}): SwapQuote => ({
  amountIn: '1234567',
  amountInMax: '1240000',
  amountOut: '5000000',
  amountOutMin: '4990000',
  ...overrides,
}) as SwapQuote

describe('getRepaySwapReviewInputAmount', () => {
  it('uses quote-derived source input limit for target-debt swaps', () => {
    expect(getRepaySwapReviewInputAmount({
      amount: '',
      quote: makeQuote(),
      sourceDecimals: 6n,
      swapperMode: SwapperMode.TARGET_DEBT,
    })).toBe('1.24')
  })

  it('keeps the user-entered source amount for exact-in swaps', () => {
    expect(getRepaySwapReviewInputAmount({
      amount: '3.5',
      quote: makeQuote(),
      sourceDecimals: 6n,
      swapperMode: SwapperMode.EXACT_IN,
    })).toBe('3.5')
  })
})
