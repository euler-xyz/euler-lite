import { describe, it, expect } from 'vitest'
import {
  nanoToValue,
  valueToNano,
  formatTtl,
  formatTtlRelative,
  roundAndCompactTokens,
} from '~/utils/crypto-utils'

describe('nanoToValue', () => {
  it('converts bigint to number with default 9 decimals', () => {
    expect(nanoToValue(1_000_000_000n, 9)).toBe(1)
  })

  it('converts with 18 decimals', () => {
    expect(nanoToValue(1n * 10n ** 18n, 18)).toBe(1)
  })

  it('converts with 6 decimals', () => {
    expect(nanoToValue(1_500_000n, 6)).toBe(1.5)
  })

  it('handles zero', () => {
    expect(nanoToValue(0n, 18)).toBe(0)
  })

  it('handles string input', () => {
    expect(nanoToValue('1000000', 6)).toBe(1)
  })

  it('handles negative bigint', () => {
    expect(nanoToValue(-1_000_000_000n, 9)).toBe(-1)
  })

  it('handles bigint decimal parameter', () => {
    expect(nanoToValue(1_000_000n, 6n)).toBe(1)
  })
})

describe('valueToNano', () => {
  it('converts number to bigint with decimals', () => {
    expect(valueToNano(1, 9)).toBe(1_000_000_000n)
  })

  it('converts with 18 decimals', () => {
    expect(valueToNano(1, 18)).toBe(10n ** 18n)
  })

  it('returns 0n for zero', () => {
    expect(valueToNano(0, 9)).toBe(0n)
  })

  it('returns 0n for empty string', () => {
    expect(valueToNano('', 9)).toBe(0n)
  })

  it('truncates excess decimal places', () => {
    // "1.123456789" with 6 decimals → truncates to "1.123456"
    expect(valueToNano('1.123456789', 6)).toBe(1_123_456n)
  })

  it('handles string input', () => {
    expect(valueToNano('1.5', 6)).toBe(1_500_000n)
  })

  it('handles integer string input (no decimal point)', () => {
    expect(valueToNano('100', 6)).toBe(100_000_000n)
  })

  it('handles negative number input', () => {
    expect(valueToNano(-1.5, 6)).toBe(-1_500_000n)
  })

  it('handles small number input stringified as scientific notation', () => {
    expect(valueToNano(2.8478322e-7, 25)).toBe(2_847_832_200_000_000_000n)
  })

  it('preserves precision from scientific notation number strings', () => {
    expect(valueToNano(2.5345658399999994e-7, 25)).toBe(2_534_565_839_999_999_400n)
  })

  it('handles negative scientific notation input', () => {
    expect(valueToNano('-1.5e-3', 6)).toBe(-1_500n)
  })

  it('matches equivalent plain decimal strings for scientific notation inputs', () => {
    expect(valueToNano(1.2530461679999999e-6, 25)).toBe(valueToNano('0.0000012530461679999999', 25))
  })

  it('truncates expanded scientific notation to the requested decimals', () => {
    expect(valueToNano('1.23456789e-3', 6)).toBe(1_234n)
  })

  it('handles positive scientific notation exponents', () => {
    expect(valueToNano('1.23e+3', 6)).toBe(1_230_000_000n)
  })

  it('truncates scientific notation values smaller than the target precision to zero', () => {
    expect(valueToNano(1e-30, 25)).toBe(0n)
  })
})

describe('formatTtl', () => {
  const TTL_INFINITY = BigInt('0x7fffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff')
  const TTL_MORE_THAN_ONE_YEAR = TTL_INFINITY - 1n
  const TTL_LIQUIDATION = -1n
  const TTL_ERROR = -2n

  it('returns undefined for undefined', () => {
    expect(formatTtl(undefined)).toBeUndefined()
  })

  it('returns infinity display for TTL_INFINITY', () => {
    expect(formatTtl(TTL_INFINITY)).toEqual({ display: '∞', type: 'success' })
  })

  it('returns >1 year for TTL_MORE_THAN_ONE_YEAR', () => {
    expect(formatTtl(TTL_MORE_THAN_ONE_YEAR)).toEqual({ display: '>1 year', type: 'success' })
  })

  it('returns liquidation message for TTL_LIQUIDATION', () => {
    expect(formatTtl(TTL_LIQUIDATION)).toEqual({ display: 'Eligible for liquidation', type: 'error' })
  })

  it('returns error for TTL_ERROR', () => {
    expect(formatTtl(TTL_ERROR)).toEqual({ display: 'Error', type: 'error' })
  })

  it('returns <1 day for 0', () => {
    expect(formatTtl(0n)).toEqual({ display: '<1 day', type: 'error' })
  })

  it('returns singular day for 1', () => {
    expect(formatTtl(1n)).toEqual({ display: '1 day', type: 'error', days: 1 })
  })

  it('returns warning for 3 days', () => {
    expect(formatTtl(3n)).toEqual({ display: '3 days', type: 'warning', days: 3 })
  })

  it('returns info for 10 days', () => {
    expect(formatTtl(10n)).toEqual({ display: '10 days', type: 'info', days: 10 })
  })

  it('returns success for 30 days', () => {
    expect(formatTtl(30n)).toEqual({ display: '30 days', type: 'success', days: 30 })
  })

  it('returns success for 365 days', () => {
    expect(formatTtl(365n)).toEqual({ display: '365 days', type: 'success', days: 365 })
  })

  it('returns error type at boundary (2 days)', () => {
    expect(formatTtl(2n)).toEqual({ display: '2 days', type: 'warning', days: 2 })
  })

  it('returns warning type at boundary (7 days)', () => {
    expect(formatTtl(7n)).toEqual({ display: '7 days', type: 'info', days: 7 })
  })

  it('returns info type at boundary (14 days)', () => {
    expect(formatTtl(14n)).toEqual({ display: '14 days', type: 'success', days: 14 })
  })
})

describe('formatTtlRelative', () => {
  it('returns dash for undefined', () => {
    expect(formatTtlRelative(undefined)).toBe('-')
  })

  it('prefixes with "in" for day counts', () => {
    expect(formatTtlRelative(10n)).toBe('in 10 days')
  })

  it('does not prefix special messages', () => {
    expect(formatTtlRelative(0n)).toBe('<1 day')
  })

  it('prefixes singular day', () => {
    expect(formatTtlRelative(1n)).toBe('in 1 day')
  })
})

describe('roundAndCompactTokens', () => {
  it('returns 0 for zero amount', () => {
    expect(roundAndCompactTokens(0n, 18n)).toBe('0')
  })

  it('formats values >= 1 compactly', () => {
    // 1000 tokens with 18 decimals
    const amount = 1000n * 10n ** 18n
    const result = roundAndCompactTokens(amount, 18n)
    expect(result).toBe('1K')
  })

  it('formats values with first significant digit at index 0 or 1', () => {
    // 0.5 tokens with 18 decimals → firstSignificantIndex = 0
    const amount = 5n * 10n ** 17n
    const result = roundAndCompactTokens(amount, 18n)
    expect(result).toBe('0.5')
  })

  it('formats very small values with precision', () => {
    // 0.001 tokens with 18 decimals → firstSignificantIndex = 2
    const amount = 10n ** 15n
    const result = roundAndCompactTokens(amount, 18n)
    expect(result).toBe('0.001')
  })

  it('formats 1 token with 6 decimals', () => {
    const amount = 1_000_000n
    const result = roundAndCompactTokens(amount, 6n)
    expect(result).toBe('1')
  })
})
