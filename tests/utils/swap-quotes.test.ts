import { describe, it, expect } from 'vitest'
import {
  getQuoteCardAmount,
  getQuoteCardScore,
  getQuoteAmount,
  sortQuoteCards,
  pickBestQuote,
  getQuoteDiffPct,
} from '~/utils/swapQuotes'
import type { SwapApiQuote } from '~/entities/swap'

const makeQuote = (amountIn: string, amountOut: string): SwapApiQuote =>
  ({ amountIn, amountOut }) as SwapApiQuote

const makeCard = (provider: string, amountIn: string, amountOut: string) => ({
  provider,
  quote: makeQuote(amountIn, amountOut),
  fetchedAt: 0,
})

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
      makeCard('A', '100', '200'),
      makeCard('B', '100', '300'),
      makeCard('C', '100', '100'),
    ]
    const sorted = sortQuoteCards(cards, 'amountOut', 'max')
    expect(sorted[0].provider).toBe('B')
    expect(sorted[1].provider).toBe('A')
    expect(sorted[2].provider).toBe('C')
  })

  it('sorts by min amountIn (ascending)', () => {
    const cards = [
      makeCard('A', '300', '100'),
      makeCard('B', '100', '100'),
      makeCard('C', '200', '100'),
    ]
    const sorted = sortQuoteCards(cards, 'amountIn', 'min')
    expect(sorted[0].provider).toBe('B')
    expect(sorted[1].provider).toBe('C')
    expect(sorted[2].provider).toBe('A')
  })

  it('does not mutate original array', () => {
    const cards = [
      makeCard('A', '100', '100'),
      makeCard('B', '100', '200'),
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
