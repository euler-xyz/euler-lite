import { describe, expect, it } from 'vitest'
import { getCowSwapQuoteOrderAmounts } from '~/entities/cowswap/quote-utils'

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
})
