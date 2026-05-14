import { describe, it, expect } from 'vitest'
import type { Address } from 'viem'
import { shouldInvertOraclePrice } from '~/utils/oracle-label'
import { USD_ADDRESS } from '~/entities/constants'

const STRCx: Address = '0x1Aad217B8F78dbA5E6693460e8470F8b1A3977f3'
const WETH: Address = '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2'
const stETH: Address = '0xae7ab96520DE3A18E5e111B5EaAb095312D7fE84'
const USDC: Address = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

describe('shouldInvertOraclePrice', () => {
  it('inverts when the caller direction is opposite to the adapter wiring', () => {
    // Adapter wired on-chain (USD, STRCx). Router resolved as (STRCx, USD).
    // The leaf is being called inverse → invert displayed rate.
    expect(shouldInvertOraclePrice({
      metaBase: USD_ADDRESS,
      metaQuote: STRCx,
      callerBase: STRCx,
      callerQuote: USD_ADDRESS,
    })).toBe(true)
  })

  it('does not invert when the caller direction matches the adapter wiring', () => {
    // Naturally wired ETH/USD: adapter base = WETH, quote = USD, caller asks (WETH, USD).
    expect(shouldInvertOraclePrice({
      metaBase: WETH,
      metaQuote: USD_ADDRESS,
      callerBase: WETH,
      callerQuote: USD_ADDRESS,
    })).toBe(false)
  })

  it('inverts a wstETH/stETH adapter when caller flips the wiring', () => {
    expect(shouldInvertOraclePrice({
      metaBase: WETH,
      metaQuote: stETH,
      callerBase: stETH,
      callerQuote: WETH,
    })).toBe(true)
  })

  it('returns false when meta base is missing (e.g. ERC4626 synthetic adapter)', () => {
    expect(shouldInvertOraclePrice({
      metaBase: undefined,
      metaQuote: STRCx,
      callerBase: STRCx,
      callerQuote: USD_ADDRESS,
    })).toBe(false)
  })

  it('returns false when meta quote is missing', () => {
    expect(shouldInvertOraclePrice({
      metaBase: USD_ADDRESS,
      metaQuote: undefined,
      callerBase: STRCx,
      callerQuote: USD_ADDRESS,
    })).toBe(false)
  })

  it('returns false when the caller pair matches the wiring in neither direction', () => {
    expect(shouldInvertOraclePrice({
      metaBase: USD_ADDRESS,
      metaQuote: STRCx,
      callerBase: USDC,
      callerQuote: WETH,
    })).toBe(false)
  })

  it('returns false when both meta sides are the same address (degenerate)', () => {
    expect(shouldInvertOraclePrice({
      metaBase: USD_ADDRESS,
      metaQuote: USD_ADDRESS,
      callerBase: USD_ADDRESS,
      callerQuote: USD_ADDRESS,
    })).toBe(false)
  })

  it('compares addresses case-insensitively', () => {
    expect(shouldInvertOraclePrice({
      metaBase: USD_ADDRESS.toUpperCase() as Address,
      metaQuote: STRCx.toLowerCase() as Address,
      callerBase: STRCx.toUpperCase() as Address,
      callerQuote: USD_ADDRESS.toLowerCase() as Address,
    })).toBe(true)
  })
})
