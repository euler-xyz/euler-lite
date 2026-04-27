import { describe, it, expect } from 'vitest'
import {
  getQuoteCardAmount,
  getQuoteCardScore,
  getQuoteAmount,
  sortQuoteCards,
  pickBestQuote,
  getQuoteDiffPct,
  computeQuoteSlippage,
} from '~/utils/swapQuotes'
import { type SwapApiQuote, SwapperMode } from '~/entities/swap'

const makeQuote = (amountIn: string, amountOut: string): SwapApiQuote =>
  ({ amountIn, amountOut }) as SwapApiQuote

const makeSlippageQuote = (amountOut: string, amountOutMin: string): SwapApiQuote =>
  ({ amountOut, amountOutMin }) as SwapApiQuote

const makeTargetDebtSlippageQuote = (amountIn: string, amountInMax: string): SwapApiQuote =>
  ({ amountIn, amountInMax }) as SwapApiQuote

describe('getQuoteAmount', () => {
  it('returns 0n for null quote', () => {
    expect(getQuoteAmount(null, 'amountIn')).toBe(0n)
  })

  it('returns 0n for undefined quote', () => {
    expect(getQuoteAmount(undefined, 'amountOut')).toBe(0n)
  })

  it('returns bigint value from quote', () => {
    const quote = makeQuote('1000', '2000')
    expect(getQuoteAmount(quote, 'amountIn')).toBe(1000n)
    expect(getQuoteAmount(quote, 'amountOut')).toBe(2000n)
  })

  it('returns 0n for non-numeric quote field', () => {
    const quote = { amountIn: 'invalid', amountOut: '200' } as SwapApiQuote
    expect(getQuoteAmount(quote, 'amountIn')).toBe(0n)
  })

  it('returns 0n for null field value', () => {
    const quote = { amountIn: null, amountOut: '200' } as unknown as SwapApiQuote
    expect(getQuoteAmount(quote, 'amountIn')).toBe(0n)
  })
})

describe('sortQuoteCards', () => {
  it('sorts by max amountOut (descending)', () => {
    const cards = [
      { provider: 'A', quote: makeQuote('100', '200') },
      { provider: 'B', quote: makeQuote('100', '300') },
      { provider: 'C', quote: makeQuote('100', '100') },
    ]
    const sorted = sortQuoteCards(cards, 'amountOut', 'max')
    expect(sorted[0].provider).toBe('B')
    expect(sorted[1].provider).toBe('A')
    expect(sorted[2].provider).toBe('C')
  })

  it('sorts by min amountIn (ascending)', () => {
    const cards = [
      { provider: 'A', quote: makeQuote('300', '100') },
      { provider: 'B', quote: makeQuote('100', '100') },
      { provider: 'C', quote: makeQuote('200', '100') },
    ]
    const sorted = sortQuoteCards(cards, 'amountIn', 'min')
    expect(sorted[0].provider).toBe('B')
    expect(sorted[1].provider).toBe('C')
    expect(sorted[2].provider).toBe('A')
  })

  it('does not mutate original array', () => {
    const cards = [
      { provider: 'A', quote: makeQuote('100', '100') },
      { provider: 'B', quote: makeQuote('100', '200') },
    ]
    const sorted = sortQuoteCards(cards, 'amountOut', 'max')
    expect(cards[0].provider).toBe('A')
    expect(sorted[0].provider).toBe('B')
  })

  it('handles empty array', () => {
    expect(sortQuoteCards([], 'amountOut', 'max')).toEqual([])
  })

  it('sorts max quotes by USD output minus gas USD', () => {
    const cards = [
      { provider: 'A', quote: makeQuote('100', '300'), amountUsd: 339, gasCostUsd: 4.82 },
      { provider: 'B', quote: makeQuote('100', '200'), amountUsd: 340, gasCostUsd: 0 },
    ]
    const sorted = sortQuoteCards(cards, 'amountOut', 'max')
    expect(sorted[0].provider).toBe('B')
    expect(sorted[1].provider).toBe('A')
  })

  it('sorts min quotes by USD input plus gas USD', () => {
    const cards = [
      { provider: 'A', quote: makeQuote('100', '300'), amountUsd: 339, gasCostUsd: 4.82 },
      { provider: 'B', quote: makeQuote('200', '300'), amountUsd: 340, gasCostUsd: 0 },
    ]
    const sorted = sortQuoteCards(cards, 'amountIn', 'min')
    expect(sorted[0].provider).toBe('B')
  })

  it('ranks cards with USD score ahead of cards without', () => {
    const cards = [
      { provider: 'A', quote: makeQuote('100', '200') },
      { provider: 'B', quote: makeQuote('100', '300'), amountUsd: 300 },
    ]
    const sorted = sortQuoteCards(cards, 'amountOut', 'max')
    expect(sorted[0].provider).toBe('B')
  })

  it('falls back to raw token amount when no card has a USD score', () => {
    const cards = [
      { provider: 'A', quote: makeQuote('100', '200') },
      { provider: 'B', quote: makeQuote('100', '300') },
    ]
    const sorted = sortQuoteCards(cards, 'amountOut', 'max')
    expect(sorted[0].provider).toBe('B')
  })
})

describe('getQuoteCardAmount', () => {
  it('returns the raw quote amount regardless of gas', () => {
    expect(getQuoteCardAmount(
      { provider: 'A', quote: makeQuote('100', '300'), gasCostUsd: 25 },
      'amountOut',
    )).toBe(300n)
    expect(getQuoteCardAmount(
      { provider: 'A', quote: makeQuote('100', '300'), gasCostUsd: 25 },
      'amountIn',
    )).toBe(100n)
  })
})

describe('getQuoteCardScore', () => {
  it('returns null when amountUsd is unset', () => {
    expect(getQuoteCardScore(
      { provider: 'A', quote: makeQuote('100', '300') },
      'max',
    )).toBeNull()
  })

  it('subtracts gas USD for max compare', () => {
    expect(getQuoteCardScore(
      { provider: 'A', quote: makeQuote('100', '300'), amountUsd: 340, gasCostUsd: 4.82 },
      'max',
    )).toBeCloseTo(335.18)
  })

  it('adds gas USD for min compare', () => {
    expect(getQuoteCardScore(
      { provider: 'A', quote: makeQuote('100', '300'), amountUsd: 100, gasCostUsd: 5 },
      'min',
    )).toBe(105)
  })

  it('treats missing gas as zero', () => {
    expect(getQuoteCardScore(
      { provider: 'A', quote: makeQuote('100', '300'), amountUsd: 100 },
      'max',
    )).toBe(100)
  })
})

describe('pickBestQuote', () => {
  it('returns null for empty array', () => {
    expect(pickBestQuote([], 'amountOut', 'max')).toBeNull()
  })

  it('returns single quote when array has one element', () => {
    const quotes = [makeQuote('100', '200')]
    expect(pickBestQuote(quotes, 'amountOut', 'max')).toBe(quotes[0])
  })

  it('picks max amountOut', () => {
    const quotes = [makeQuote('100', '200'), makeQuote('100', '300')]
    const best = pickBestQuote(quotes, 'amountOut', 'max')
    expect(getQuoteAmount(best, 'amountOut')).toBe(300n)
  })

  it('picks min amountIn', () => {
    const quotes = [makeQuote('300', '100'), makeQuote('100', '100')]
    const best = pickBestQuote(quotes, 'amountIn', 'min')
    expect(getQuoteAmount(best, 'amountIn')).toBe(100n)
  })
})

describe('getQuoteDiffPct', () => {
  it('returns null when amounts are equal', () => {
    expect(getQuoteDiffPct(100, 100, 'max')).toBeNull()
  })

  it('returns null when bestAmount is zero', () => {
    expect(getQuoteDiffPct(100, 0, 'max')).toBeNull()
  })

  it('returns null when quoteAmount is zero', () => {
    expect(getQuoteDiffPct(0, 100, 'max')).toBeNull()
  })

  it('calculates diff percentage for max compare', () => {
    expect(getQuoteDiffPct(100, 200, 'max')).toBe(50)
  })

  it('calculates diff percentage for min compare', () => {
    expect(getQuoteDiffPct(200, 100, 'min')).toBe(100)
  })

  it('returns null when quote is better than best in min mode', () => {
    expect(getQuoteDiffPct(50, 100, 'min')).toBeNull()
  })

  it('returns null when quote is better than best in max mode', () => {
    expect(getQuoteDiffPct(200, 100, 'max')).toBeNull()
  })
})

describe('computeQuoteSlippage', () => {
  it('returns null for null quote', () => {
    expect(computeQuoteSlippage(null)).toBeNull()
  })

  it('returns null when amountOut is zero', () => {
    expect(computeQuoteSlippage(makeSlippageQuote('0', '95'))).toBeNull()
  })

  it('returns null when amountOutMin is missing', () => {
    expect(computeQuoteSlippage({ amountOut: '100' } as SwapApiQuote)).toBeNull()
  })

  it('returns null when amountOutMin is invalid', () => {
    expect(computeQuoteSlippage(makeSlippageQuote('100', 'invalid'))).toBeNull()
  })

  it('returns 100 when amountOutMin is zero', () => {
    expect(computeQuoteSlippage(makeSlippageQuote('100', '0'))).toBe(100)
  })

  it('returns 0 when amountOutMin matches amountOut', () => {
    expect(computeQuoteSlippage(makeSlippageQuote('100', '100'))).toBe(0)
  })

  it('returns null when amountOutMin is greater than amountOut', () => {
    expect(computeQuoteSlippage(makeSlippageQuote('100', '101'))).toBeNull()
  })

  it('derives the quote slippage percentage from amountOut and amountOutMin', () => {
    expect(computeQuoteSlippage(makeSlippageQuote('1000', '995'))).toBe(0.5)
  })

  it('rounds down to basis-point precision', () => {
    expect(computeQuoteSlippage(makeSlippageQuote('3333', '3300'))).toBe(0.99)
  })

  it('derives target debt quote slippage from amountIn and amountInMax', () => {
    expect(computeQuoteSlippage(
      makeTargetDebtSlippageQuote('1000', '1005'),
      SwapperMode.TARGET_DEBT,
    )).toBe(0.5)
  })

  it('returns 0 when target debt amountInMax matches amountIn', () => {
    expect(computeQuoteSlippage(
      makeTargetDebtSlippageQuote('1000', '1000'),
      SwapperMode.TARGET_DEBT,
    )).toBe(0)
  })

  it('returns null when target debt amountInMax is below amountIn', () => {
    expect(computeQuoteSlippage(
      makeTargetDebtSlippageQuote('1000', '999'),
      SwapperMode.TARGET_DEBT,
    )).toBeNull()
  })

  it('returns null when target debt amountInMax is missing', () => {
    expect(computeQuoteSlippage(
      { amountIn: '1000' } as SwapApiQuote,
      SwapperMode.TARGET_DEBT,
    )).toBeNull()
  })
})
