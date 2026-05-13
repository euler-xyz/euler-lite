import { describe, it, expect } from 'vitest'
import { parseOracleLabelPair, shouldInvertOraclePrice } from '~/utils/oracle-label'

describe('parseOracleLabelPair', () => {
  it('parses a slash-separated pair', () => {
    expect(parseOracleLabelPair('STRC / USD')).toEqual(['STRC', 'USD'])
  })

  it('trims whitespace around each side', () => {
    expect(parseOracleLabelPair('  ETH  /  USD  ')).toEqual(['ETH', 'USD'])
  })

  it('returns null for undefined input', () => {
    expect(parseOracleLabelPair(undefined)).toBeNull()
  })

  it('returns null when the separator is missing', () => {
    expect(parseOracleLabelPair('STRCUSD')).toBeNull()
  })

  it('returns null when there are more than two segments', () => {
    expect(parseOracleLabelPair('A / B / C')).toBeNull()
  })
})

describe('shouldInvertOraclePrice', () => {
  describe('no label parses', () => {
    it('returns false when label is undefined', () => {
      expect(shouldInvertOraclePrice(undefined, 'USD', 'STRCx')).toBe(false)
    })

    it('returns false when label cannot be parsed', () => {
      expect(shouldInvertOraclePrice('STRCUSD', 'USD', 'STRCx')).toBe(false)
    })
  })

  describe('label aligned with adapter wiring', () => {
    it('does not invert when label and wiring agree', () => {
      // adapter.base=ETH-wrapper, adapter.quote=USD, label="ETH / USD"
      // getQuote returns USD per ETH, label means USD per ETH — agree.
      expect(shouldInvertOraclePrice('ETH / USD', 'WETH', 'USD')).toBe(false)
    })

    it('does not invert when wrapped quote is on the right', () => {
      // adapter.base=USDC, adapter.quote=USDC.e wrapper — extremely contrived,
      // but it exercises the right-side wrapper match.
      expect(shouldInvertOraclePrice('USDC / USDC.e', 'USDC', 'USDC.e')).toBe(false)
    })
  })

  describe('label flipped relative to adapter wiring', () => {
    it('inverts when STRCx is on the quote side', () => {
      // The original failing case from the PR description.
      expect(shouldInvertOraclePrice('STRC / USD', 'USD', 'STRCx')).toBe(true)
    })

    it('inverts when wSTRCx is on the quote side', () => {
      // The case the previous fix missed — prefix wrapper marker.
      expect(shouldInvertOraclePrice('STRC / USD', 'USD', 'wSTRCx')).toBe(true)
    })

    it('inverts for wstETH wrapped around ETH', () => {
      // Long leading marker "wst" on a 3-letter core.
      expect(shouldInvertOraclePrice('ETH / USD', 'USD', 'wstETH')).toBe(true)
    })

    it('inverts for WETH wrapped around ETH', () => {
      expect(shouldInvertOraclePrice('ETH / USD', 'USD', 'WETH')).toBe(true)
    })
  })

  describe('false-positive guards', () => {
    it('does not match USD against USDC', () => {
      // "USDC / USD" with adapter base=USDC, quote=USD: aligned → no invert.
      // Should not get confused by "USD" being a prefix of "USDC".
      expect(shouldInvertOraclePrice('USDC / USD', 'USDC', 'USD')).toBe(false)
    })

    it('does not match BTC against BTCB without a leading marker', () => {
      // BTCB (no leading marker) should NOT be treated as a BTC wrapper here.
      // If both wirings fail to match, fall back to no inversion.
      expect(shouldInvertOraclePrice('BTC / USD', 'USD', 'BTCB')).toBe(false)
    })

    it('does not match unrelated symbols that happen to share a prefix', () => {
      // "USDC" and "USDT" share a long prefix but are distinct assets.
      expect(shouldInvertOraclePrice('USDC / USD', 'USD', 'USDT')).toBe(false)
    })
  })

  describe('case and whitespace tolerance', () => {
    it('is case-insensitive', () => {
      expect(shouldInvertOraclePrice('strc / usd', 'USD', 'STRCx')).toBe(true)
    })

    it('tolerates extra whitespace', () => {
      expect(shouldInvertOraclePrice('  STRC  /  USD  ', 'USD', 'STRCx')).toBe(true)
    })
  })
})
