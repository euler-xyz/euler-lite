import { describe, it, expect } from 'vitest'
import type { Address } from 'viem'
import { parseOracleLabelPair, shouldInvertOraclePrice } from '~/utils/oracle-label'
import { USD_ADDRESS, EUR_ADDRESS, BTC_ADDRESS, ETH_ADDRESS } from '~/entities/constants'

// Arbitrary ERC20 addresses for testing — values are not checked, only whether
// the helper treats them as designators (the designator set is hard-coded).
const STRCx: Address = '0x1Aad217B8F78dbA5E6693460e8470F8b1A3977f3'
const wSTRCx: Address = '0x0B2456017C5Df2dFc0289740C4b352049892780C'
const WETH: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const stETH: Address = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84'
const wstETH: Address = '0x7f39C581F595B53c5cb19bD0b3f8dA6c935E2Ca0'
const USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'
const USDT: Address = '0xdAC17F958D2ee523a2206206994597C13D831ec7'
const BTCB: Address = '0x0000000000000000000000000000000000BBccBB'

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
  describe('designator-address anchoring', () => {
    it('inverts when adapter.base is a designator and quote is an ERC20', () => {
      // STRC / USD adapter wired (USD, STRCx) on chain.
      expect(shouldInvertOraclePrice('STRC / USD', USD_ADDRESS, STRCx, 'USD', 'STRCx')).toBe(true)
    })

    it('inverts when base is the USD designator regardless of label parseability', () => {
      // Symbol hasn't resolved yet — quoteSymbol is the shortened address.
      // The address anchor still tells us to invert.
      expect(shouldInvertOraclePrice('STRC / USD', USD_ADDRESS, STRCx, 'USD', '0x1Aad…7f3')).toBe(true)
    })

    it('inverts when base is the USD designator even with an empty label', () => {
      expect(shouldInvertOraclePrice(undefined, USD_ADDRESS, STRCx, 'USD', 'STRCx')).toBe(true)
    })

    it('does not invert when adapter.quote is the designator', () => {
      // Natural wiring: asset/fiat with quote = USD.
      expect(shouldInvertOraclePrice('ETH / USD', WETH, USD_ADDRESS, 'WETH', 'USD')).toBe(false)
    })

    it('inverts for BTC designator on the base side', () => {
      expect(shouldInvertOraclePrice('WBTC / BTC', BTC_ADDRESS, wSTRCx, 'BTC', 'WBTC')).toBe(true)
    })

    it('does not invert for ETH designator on the quote side', () => {
      // wstETH / ETH with adapter wired (wstETH, ETH) — natural direction.
      expect(shouldInvertOraclePrice('wstETH / ETH', wstETH, ETH_ADDRESS, 'wstETH', 'ETH')).toBe(false)
    })
  })

  describe('symbol-based fallback (no designator on either side)', () => {
    it('returns false when neither side is a designator and the label cannot be parsed', () => {
      expect(shouldInvertOraclePrice(undefined, WETH, USDC, 'WETH', 'USDC')).toBe(false)
    })

    it('handles ERC20-only pair via symbol scoring', () => {
      // Hypothetical "WETH / USDC" wired as (USDC, WETH) — needs invert.
      expect(shouldInvertOraclePrice('WETH / USDC', USDC, WETH, 'USDC', 'WETH')).toBe(true)
    })

    it('does not invert an aligned ERC20-only pair', () => {
      expect(shouldInvertOraclePrice('WETH / USDC', WETH, USDC, 'WETH', 'USDC')).toBe(false)
    })

    it('breaks alias ambiguity in favour of exact matches', () => {
      // Both label sides loosely match both wirings (stETH ↔ ETH-string),
      // but exact matches outscore loose ones — inversion is chosen.
      expect(shouldInvertOraclePrice('wstETH / stETH', stETH, wstETH, 'stETH', 'wstETH')).toBe(true)
      expect(shouldInvertOraclePrice('wstETH / stETH', wstETH, stETH, 'wstETH', 'stETH')).toBe(false)
    })
  })

  describe('false-positive guards', () => {
    it('does not match USD substring inside USDC', () => {
      // Both sides are ERC20 here, fallback path. "USD" inside "USDC" rejected.
      expect(shouldInvertOraclePrice('USDC / USD', USDC, USDC, 'USDC', 'USD')).toBe(false)
    })

    it('does not match BTC inside BTCB without a leading marker', () => {
      // BTCB is a real address; designator anchor (BTC) is on neither side
      // since we pass BTCB and USDC, not BTC_ADDRESS.
      expect(shouldInvertOraclePrice('BTC / USD', USDC, BTCB, 'USD', 'BTCB')).toBe(false)
    })

    it('does not invert two unrelated stablecoins that share a prefix', () => {
      expect(shouldInvertOraclePrice('USDC / USD', USDC, USDT, 'USDC', 'USDT')).toBe(false)
    })
  })

  describe('case and whitespace tolerance', () => {
    it('is case-insensitive for symbol fallback', () => {
      expect(shouldInvertOraclePrice('strc / usd', USD_ADDRESS, STRCx, 'usd', 'strcx')).toBe(true)
    })

    it('tolerates extra whitespace in the label', () => {
      expect(shouldInvertOraclePrice('  STRC  /  USD  ', USD_ADDRESS, STRCx, 'USD', 'STRCx')).toBe(true)
    })
  })

  describe('uses EUR designator as well', () => {
    it('inverts when EUR is on the base side', () => {
      expect(shouldInvertOraclePrice('XAU / EUR', EUR_ADDRESS, STRCx, 'EUR', 'XAU')).toBe(true)
    })
  })
})
