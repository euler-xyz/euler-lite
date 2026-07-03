import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SLIPPAGE,
  DEFAULT_STABLECOIN_SLIPPAGE,
} from '~/entities/constants'
import { getDefaultSlippageForContext } from '~/composables/useSlippage'
import { getRefinanceSlippageContext } from '~/utils/refinance-slippage'

const getRefinanceDefault = (
  legs: Parameters<typeof getRefinanceSlippageContext>[0],
) => getDefaultSlippageForContext(getRefinanceSlippageContext(legs))

describe('getRefinanceSlippageContext', () => {
  it('uses the actual debt quote direction for debt-only refinance defaults', () => {
    expect(getRefinanceDefault([
      { fromSymbol: 'USDC', toSymbol: 'WETH' },
    ])).toBe(DEFAULT_SLIPPAGE)

    expect(getRefinanceDefault([
      { fromSymbol: 'USDT', toSymbol: 'USDC' },
    ])).toBe(DEFAULT_STABLECOIN_SLIPPAGE)
  })

  it('uses the stablecoin default only when every active swap leg is stable-to-stable', () => {
    expect(getRefinanceDefault([
      { fromSymbol: 'USDC', toSymbol: 'RLUSD' },
      { fromSymbol: 'USDT', toSymbol: 'USDC' },
    ])).toBe(DEFAULT_STABLECOIN_SLIPPAGE)

    expect(getRefinanceDefault([
      { fromSymbol: 'USDC', toSymbol: 'RLUSD' },
      { fromSymbol: 'WETH', toSymbol: 'USDC' },
    ])).toBe(DEFAULT_SLIPPAGE)
  })

  it('falls back to the normal default without a complete active swap leg', () => {
    expect(getRefinanceDefault([])).toBe(DEFAULT_SLIPPAGE)
    expect(getRefinanceDefault([
      { fromSymbol: 'USDC' },
      { toSymbol: 'USDT' },
    ])).toBe(DEFAULT_SLIPPAGE)
  })
})
