import { describe, it, expect } from 'vitest'
import {
  truncate,
  shortenAddress,
  truncateAddressForSubgraph,
  formatNumber,
  formatUsdValue,
  formatSignificant,
  formatSignificantFloor,
  compactNumber,
  formatCompactUsdValue,
  trimTrailingZeros,
  formatSmartAmount,
  formatHealthScore,
  preciseNumber,
  stringToColor,
} from '~/utils/string-utils'

describe('truncate', () => {
  it('truncates with default length', () => {
    const result = truncate('0x1234567890abcdef')
    expect(result).toBe('0x1234...cdef')
  })

  it('truncates with custom length', () => {
    const result = truncate('0x1234567890abcdef', 4)
    expect(result).toBe('0x12...cdef')
  })

  it('handles short strings', () => {
    expect(truncate('abcd')).toBe('abcd...abcd')
  })
})

describe('shortenAddress', () => {
  it('shortens a full address to first 6 and last 4 chars', () => {
    expect(shortenAddress('0x1234567890abcdef1234567890abcdef12345678')).toBe('0x1234...5678')
  })

  it('matches truncate(addr, 6) exactly', () => {
    const addr = '0xabcdef0123456789abcdef0123456789abcdef01'
    expect(shortenAddress(addr)).toBe(truncate(addr, 6))
  })

  it('defaults to an empty string', () => {
    expect(shortenAddress()).toBe('...')
  })
})

describe('truncateAddressForSubgraph', () => {
  it('lowercases and truncates to 40 chars', () => {
    const addr = '0x1234567890ABCDEF1234567890abcdef12345678'
    const result = truncateAddressForSubgraph(addr)
    expect(result).toBe(addr.toLowerCase().slice(0, 40))
    expect(result.length).toBe(40)
  })

  it('returns full string if shorter than 40 chars', () => {
    expect(truncateAddressForSubgraph('0xABCD')).toBe('0xabcd')
  })
})

describe('formatNumber', () => {
  it('formats normal number', () => {
    expect(formatNumber(1234.567)).toBe('1,234.57')
  })

  it('returns dash for non-finite', () => {
    expect(formatNumber(Infinity)).toBe('-')
    expect(formatNumber(NaN)).toBe('-')
  })

  it('respects fraction digits', () => {
    expect(formatNumber(1.5, 4, 4)).toBe('1.5000')
  })

  it('handles string input', () => {
    expect(formatNumber('1234.567')).toBe('1,234.57')
  })

  it('handles zero', () => {
    expect(formatNumber(0)).toBe('0.00')
  })
})

describe('formatUsdValue', () => {
  it('formats normal value', () => {
    expect(formatUsdValue(1234.56)).toBe('$1,234.56')
  })

  it('shows <$0.01 for small positive', () => {
    expect(formatUsdValue(0.005)).toBe('<$0.01')
  })

  it('shows -<$0.01 for small negative', () => {
    expect(formatUsdValue(-0.005)).toBe('-<$0.01')
  })

  it('shows $0.00 for zero', () => {
    expect(formatUsdValue(0)).toBe('$0.00')
  })

  it('shows $0.00 for non-finite', () => {
    expect(formatUsdValue(NaN)).toBe('$0.00')
    expect(formatUsdValue(Infinity)).toBe('$0.00')
  })
})

describe('formatSignificant', () => {
  it('formats with significant digits', () => {
    expect(formatSignificant(0.001234, 3)).toBe('0.00123')
  })

  it('returns 0 for non-finite', () => {
    expect(formatSignificant(NaN)).toBe('0')
    expect(formatSignificant(Infinity)).toBe('0')
  })
})

describe('formatSignificantFloor', () => {
  it('truncates instead of rounding', () => {
    // 1.99 with 2 significant digits → should be 1.9, not 2.0
    expect(formatSignificantFloor(1.99, 2)).toBe('1.9')
  })

  it('returns 0 for zero', () => {
    expect(formatSignificantFloor(0)).toBe('0')
  })

  it('returns 0 for NaN', () => {
    expect(formatSignificantFloor(NaN)).toBe('0')
  })

  it('handles negative values', () => {
    expect(formatSignificantFloor(-1.99, 2)).toBe('-1.9')
  })
})

describe('compactNumber', () => {
  it('formats large numbers compactly', () => {
    expect(compactNumber(1500000)).toBe('1.5M')
  })

  it('shows small placeholder for small positive that rounds to 0', () => {
    expect(compactNumber(0.001, 2)).toBe('<0.01')
  })

  it('shows ≈0 for small negative that rounds to -0', () => {
    expect(compactNumber(-0.001, 2)).toBe('≈0')
  })
})

describe('formatCompactUsdValue', () => {
  it('formats large values with compact notation', () => {
    expect(formatCompactUsdValue(1500000)).toBe('$1.5M')
  })

  it('shows <$0.01 for small positive', () => {
    expect(formatCompactUsdValue(0.005)).toBe('<$0.01')
  })

  it('returns $0 for non-finite', () => {
    expect(formatCompactUsdValue(NaN)).toBe('$0')
  })
})

describe('trimTrailingZeros', () => {
  it('trims trailing zeros after decimal', () => {
    expect(trimTrailingZeros('0.363002000000000000')).toBe('0.363002')
  })

  it('removes decimal point if all zeros', () => {
    expect(trimTrailingZeros('1.000000000000000000')).toBe('1')
  })

  it('trims partial zeros', () => {
    expect(trimTrailingZeros('0.10')).toBe('0.1')
  })

  it('returns as-is when no decimal', () => {
    expect(trimTrailingZeros('42')).toBe('42')
  })
})

describe('formatSmartAmount', () => {
  it('returns 0 for zero', () => {
    expect(formatSmartAmount(0)).toBe('0')
  })

  it('returns 0 for NaN', () => {
    expect(formatSmartAmount(NaN)).toBe('0')
  })

  it('formats large values with 2 decimals', () => {
    const result = formatSmartAmount(1234.5678)
    expect(result).toBe('1,234.57')
  })

  it('formats medium values with up to 4 decimals', () => {
    const result = formatSmartAmount(1.23456789)
    // >= 1, so up to 4 decimals
    expect(result).toBe('1.2346')
  })

  it('formats small values with significant digits', () => {
    const result = formatSmartAmount(0.001234)
    // first sig digit at index 2, so precision = min(4, 6) = 4
    expect(result).toBe('0.0012')
  })

  it('formats negative values', () => {
    expect(formatSmartAmount(-1234.5678)).toBe('-1,234.57')
  })

  it('formats negative small values', () => {
    expect(formatSmartAmount(-0.001234)).toBe('-0.0012')
  })
})

describe('formatHealthScore', () => {
  it('returns dash for null', () => {
    expect(formatHealthScore(null)).toBe('-')
  })

  it('returns dash for undefined', () => {
    expect(formatHealthScore(undefined)).toBe('-')
  })

  it('returns infinity for Infinity', () => {
    expect(formatHealthScore(Infinity)).toBe('∞')
  })

  it('returns infinity for very large values', () => {
    expect(formatHealthScore(1e16)).toBe('∞')
  })

  it('formats normal value', () => {
    expect(formatHealthScore(1.5)).toBe('1.50')
  })
})

describe('preciseNumber', () => {
  it('formats without grouping', () => {
    expect(preciseNumber(1234.5678, 4)).toBe('1234.5678')
  })
})

describe('stringToColor', () => {
  it('returns deterministic HSL color', () => {
    const color1 = stringToColor('test')
    const color2 = stringToColor('test')
    expect(color1).toBe(color2)
    expect(color1).toMatch(/^hsl\(\d+, 40%, 45%\)$/)
  })

  it('returns different colors for different inputs', () => {
    expect(stringToColor('abc')).not.toBe(stringToColor('xyz'))
  })
})
