import { SwapperMode, type SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { describe, expect, it } from 'vitest'
import { getSwapInputAmount } from '~/utils/swapQuotes'

describe('getSwapInputAmount', () => {
  it('uses the slippage-capped maximum for TARGET_DEBT execution', () => {
    const quote = { amountIn: '100', amountInMax: '105' } as SwapQuote

    expect(getSwapInputAmount(quote, SwapperMode.TARGET_DEBT)).toBe(105n)
  })

  it('keeps the quoted input for EXACT_IN execution', () => {
    const quote = { amountIn: '100', amountInMax: '105' } as SwapQuote

    expect(getSwapInputAmount(quote, SwapperMode.EXACT_IN)).toBe(100n)
  })
})
