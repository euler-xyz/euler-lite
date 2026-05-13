import { describe, it, expect } from 'vitest'
import type { Address } from 'viem'
import { parseOracleLabelPair, shouldInvertOraclePrice } from '~/utils/oracle-label'
import { USD_ADDRESS } from '~/entities/constants'

// Real-ish addresses for readability. The helper only compares them case-
// insensitively, so the exact values don't matter beyond being distinct.
const STRCx: Address = '0x1Aad217B8F78dbA5E6693460e8470F8b1A3977f3'
const WETH: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const stETH: Address = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84'
const USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

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
  it('inverts when the caller direction is opposite to the adapter wiring', () => {
    // Adapter wired on-chain (USD, STRCx). Router resolved as (STRCx, USD).
    // The leaf is being called in the inverse direction → invert displayed rate.
    expect(shouldInvertOraclePrice(USD_ADDRESS, STRCx, STRCx, USD_ADDRESS)).toBe(true)
  })

  it('does not invert when the caller direction matches the adapter wiring', () => {
    // Naturally wired ETH/USD: adapter base = WETH, quote = USD, caller asks (WETH, USD).
    expect(shouldInvertOraclePrice(WETH, USD_ADDRESS, WETH, USD_ADDRESS)).toBe(false)
  })

  it('handles a wstETH / stETH adapter where caller flips the wiring', () => {
    // Adapter wired (wstETH, stETH), router resolves caller direction (stETH, wstETH).
    expect(shouldInvertOraclePrice(WETH, stETH, stETH, WETH)).toBe(true)
  })

  it('returns false when meta base is missing', () => {
    expect(shouldInvertOraclePrice(undefined, STRCx, STRCx, USD_ADDRESS)).toBe(false)
  })

  it('returns false when meta quote is missing', () => {
    expect(shouldInvertOraclePrice(USD_ADDRESS, undefined, STRCx, USD_ADDRESS)).toBe(false)
  })

  it('returns false for an unexpected pairing that matches neither direction', () => {
    // meta (USD, STRCx), caller (USDC, WETH) — completely unrelated, no inversion guess.
    expect(shouldInvertOraclePrice(USD_ADDRESS, STRCx, USDC, WETH)).toBe(false)
  })

  it('compares addresses case-insensitively', () => {
    expect(
      shouldInvertOraclePrice(
        USD_ADDRESS.toUpperCase() as Address,
        STRCx.toLowerCase() as Address,
        STRCx.toUpperCase() as Address,
        USD_ADDRESS.toLowerCase() as Address,
      ),
    ).toBe(true)
  })
})
