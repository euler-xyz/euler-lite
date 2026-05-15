import { describe, expect, it } from 'vitest'
import { getCowSwapQuoteOrderAmounts, validateCowSwapQuoteOrderAmounts } from '~/entities/cowswap/quote-utils'

const makeQuote = (overrides = {}) => ({
  amountIn: '1007',
  amountInMax: '1013',
  amountOut: '2500',
  amountOutMin: '2487',
  providerData: {
    sellAmount: '1000',
    buyAmount: '2500',
    feeAmount: '7',
  },
  ...overrides,
})

describe('getCowSwapQuoteOrderAmounts', () => {
  it('uses raw CoW provider amounts and folds fee into order sell amount', () => {
    expect(getCowSwapQuoteOrderAmounts({
      providerData: {
        sellAmount: '1000',
        buyAmount: '2500',
        feeAmount: '7',
      },
    })).toEqual({
      sellAmount: 1007n,
      buyAmount: 2500n,
      feeAmount: 7n,
    })
  })

  it('reduces buy amount by slippage for exact-in CoW orders', () => {
    expect(getCowSwapQuoteOrderAmounts({
      providerData: {
        sellAmount: '1000',
        buyAmount: '2500',
        feeAmount: '7',
      },
    }, { slippage: 0.5, slippageTarget: 'buyAmount' })).toEqual({
      sellAmount: 1007n,
      buyAmount: 2487n,
      feeAmount: 7n,
    })
  })

  it('increases sell amount by slippage for repay CoW orders', () => {
    expect(getCowSwapQuoteOrderAmounts({
      providerData: {
        sellAmount: '1000',
        buyAmount: '2500',
        feeAmount: '7',
      },
    }, { slippage: 0.5, slippageTarget: 'sellAmount' })).toEqual({
      sellAmount: 1013n,
      buyAmount: 2500n,
      feeAmount: 7n,
    })
  })

  it('caps slippage-adjusted sell amount when a max sell amount is provided', () => {
    expect(getCowSwapQuoteOrderAmounts({
      providerData: {
        sellAmount: '1000',
        buyAmount: '2500',
        feeAmount: '7',
      },
    }, { slippage: 0.5, slippageTarget: 'sellAmount', maxSellAmount: 1010n })).toEqual({
      sellAmount: 1010n,
      buyAmount: 2500n,
      feeAmount: 7n,
    })
  })

  it('rejects quotes without complete positive order amounts', () => {
    expect(getCowSwapQuoteOrderAmounts({
      providerData: {
        sellAmount: '1000',
        feeAmount: '0',
      },
    })).toBeUndefined()

    expect(getCowSwapQuoteOrderAmounts({
      providerData: {
        sellAmount: '0',
        buyAmount: '2500',
        feeAmount: '0',
      },
    })).toBeUndefined()
  })

  it('rejects invalid slippage', () => {
    expect(getCowSwapQuoteOrderAmounts(makeQuote(), {
      slippage: 50.1,
      slippageTarget: 'buyAmount',
    })).toBeUndefined()
  })
})

describe('validateCowSwapQuoteOrderAmounts', () => {
  it('accepts quote-bound exact-in order amounts', () => {
    expect(validateCowSwapQuoteOrderAmounts(makeQuote(), {
      sellAmount: 1007n,
      buyAmount: 2487n,
      slippage: 0.5,
      slippageTarget: 'buyAmount',
    })).toEqual({
      sellAmount: 1007n,
      buyAmount: 2487n,
      feeAmount: 7n,
    })
  })

  it('accepts quote-bound target-debt order amounts', () => {
    expect(validateCowSwapQuoteOrderAmounts(makeQuote(), {
      sellAmount: 1013n,
      buyAmount: 2500n,
      slippage: 0.5,
      slippageTarget: 'sellAmount',
    })).toEqual({
      sellAmount: 1013n,
      buyAmount: 2500n,
      feeAmount: 7n,
    })
  })

  it('accepts exact-in order amounts bound to the requested sell amount', () => {
    expect(validateCowSwapQuoteOrderAmounts(makeQuote(), {
      sellAmount: 1007n,
      buyAmount: 2487n,
      slippage: 0.5,
      slippageTarget: 'buyAmount',
      expectedSellAmount: 1007n,
    })).toEqual({
      sellAmount: 1007n,
      buyAmount: 2487n,
      feeAmount: 7n,
    })
  })

  it('rejects submitted amounts that differ from the selected quote', () => {
    expect(() => validateCowSwapQuoteOrderAmounts(makeQuote(), {
      sellAmount: 1007n,
      buyAmount: 2486n,
      slippage: 0.5,
      slippageTarget: 'buyAmount',
    })).toThrow('CoW order amounts do not match selected quote')
  })

  it('rejects exact-in order amounts that differ from the requested sell amount', () => {
    expect(() => validateCowSwapQuoteOrderAmounts(makeQuote(), {
      sellAmount: 1007n,
      buyAmount: 2487n,
      slippage: 0.5,
      slippageTarget: 'buyAmount',
      expectedSellAmount: 1006n,
    })).toThrow('CoW quote sell amount does not match requested amount')
  })

  it('accepts raw provider amounts when display quote amounts use different units', () => {
    expect(validateCowSwapQuoteOrderAmounts(makeQuote({ amountIn: '1', amountOut: '2' }), {
      sellAmount: 1007n,
      buyAmount: 2487n,
      slippage: 0.5,
      slippageTarget: 'buyAmount',
    })).toEqual({
      sellAmount: 1007n,
      buyAmount: 2487n,
      feeAmount: 7n,
    })
  })

  it('rejects target-debt order amounts that differ from the requested buy amount', () => {
    expect(() => validateCowSwapQuoteOrderAmounts(makeQuote(), {
      sellAmount: 1013n,
      buyAmount: 2500n,
      slippage: 0.5,
      slippageTarget: 'sellAmount',
      expectedBuyAmount: 2499n,
    })).toThrow('CoW quote buy amount does not match requested amount')
  })

  it('rejects appData that differs from the quote request', () => {
    expect(() => validateCowSwapQuoteOrderAmounts(makeQuote(), {
      sellAmount: 1007n,
      buyAmount: 2487n,
      slippage: 0.5,
      slippageTarget: 'buyAmount',
      expectedAppData: '{"quoted":true}',
      actualAppData: '{"quoted":false}',
    })).toThrow('CoW quote appData does not match requested order')
  })

  it('rejects execution validation when appData request binding is missing', () => {
    expect(() => validateCowSwapQuoteOrderAmounts(makeQuote(), {
      sellAmount: 1007n,
      buyAmount: 2487n,
      slippage: 0.5,
      slippageTarget: 'buyAmount',
      actualAppData: '{"quoted":true}',
    })).toThrow('CoW quote appData is missing request binding')
  })

  it('accepts capped target-debt sell amounts within requested slippage', () => {
    expect(() => validateCowSwapQuoteOrderAmounts(makeQuote(), {
      sellAmount: 1010n,
      buyAmount: 2500n,
      slippage: 0.5,
      slippageTarget: 'sellAmount',
      maxSellAmount: 1010n,
      expectedSellAmount: 1007n,
    })).not.toThrow()
  })

  it('accepts capped target-debt sell amounts that still cover the quoted sell amount', () => {
    expect(validateCowSwapQuoteOrderAmounts(makeQuote(), {
      sellAmount: 1010n,
      buyAmount: 2500n,
      slippage: 0.5,
      slippageTarget: 'sellAmount',
      maxSellAmount: 1010n,
    })).toEqual({
      sellAmount: 1010n,
      buyAmount: 2500n,
      feeAmount: 7n,
    })
  })

  it('rejects capped target-debt sell amounts below the quoted sell amount', () => {
    expect(() => validateCowSwapQuoteOrderAmounts(makeQuote(), {
      sellAmount: 1000n,
      buyAmount: 2500n,
      slippage: 0.5,
      slippageTarget: 'sellAmount',
      maxSellAmount: 1000n,
    })).toThrow('CoW order sell amount is below quoted sell amount')
  })

  it('rejects non-finite or excessive slippage', () => {
    expect(() => validateCowSwapQuoteOrderAmounts(makeQuote(), {
      sellAmount: 1007n,
      buyAmount: 2487n,
      slippage: undefined as unknown as number,
      slippageTarget: 'buyAmount',
    })).toThrow('Valid slippage between 0 and 50% must be provided for CoW swap')

    expect(() => validateCowSwapQuoteOrderAmounts(makeQuote(), {
      sellAmount: 1007n,
      buyAmount: 2487n,
      slippage: Number.POSITIVE_INFINITY,
      slippageTarget: 'buyAmount',
    })).toThrow('Valid slippage between 0 and 50% must be provided for CoW swap')

    expect(() => validateCowSwapQuoteOrderAmounts(makeQuote(), {
      sellAmount: 1007n,
      buyAmount: 2487n,
      slippage: 50.1,
      slippageTarget: 'buyAmount',
    })).toThrow('Valid slippage between 0 and 50% must be provided for CoW swap')
  })
})
