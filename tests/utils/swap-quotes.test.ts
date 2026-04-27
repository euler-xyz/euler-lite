import { describe, it, expect } from 'vitest'
import {
  getQuoteAmount,
  sortQuoteCards,
  pickBestQuote,
  getQuoteDiffPct,
} from '~/utils/swapQuotes'
import type { SwapApiQuote } from '~/entities/swap'

const makeQuote = (amountIn: string, amountOut: string): SwapApiQuote =>
  ({ amountIn, amountOut }) as SwapApiQuote

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
    expect(cards[0].provider).toBe('A') // original unchanged
    expect(sorted[0].provider).toBe('B') // sorted has B first (higher amountOut)
  })

  it('handles empty array', () => {
    expect(sortQuoteCards([], 'amountOut', 'max')).toEqual([])
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
    expect(getQuoteDiffPct(100n, 100n, 'max')).toBeNull()
  })

  it('returns null when bestAmount is zero', () => {
    expect(getQuoteDiffPct(100n, 0n, 'max')).toBeNull()
  })

  it('returns null when quoteAmount is zero', () => {
    expect(getQuoteDiffPct(0n, 100n, 'max')).toBeNull()
  })

  it('calculates diff percentage for max compare', () => {
    // best=200, quote=100, diff=100, diffBps=100*10000/200=5000 → 50%
    const result = getQuoteDiffPct(100n, 200n, 'max')
    expect(result).toBe(50)
  })

  it('calculates diff percentage for min compare', () => {
    // best=100, quote=200, diff=200-100=100, diffBps=100*10000/100=10000 → 100%
    const result = getQuoteDiffPct(200n, 100n, 'min')
    expect(result).toBe(100)
  })

  it('returns null when quote is better than best in min mode', () => {
    // quoteAmount=50 < bestAmount=100 => diff = 50-100 = -50 <= 0 => null
    expect(getQuoteDiffPct(50n, 100n, 'min')).toBeNull()
  })

  it('returns null when quote is better than best in max mode', () => {
    // quoteAmount=200 > bestAmount=100 => diff = 100-200 = -100 <= 0 => null
    expect(getQuoteDiffPct(200n, 100n, 'max')).toBeNull()
  })
})
