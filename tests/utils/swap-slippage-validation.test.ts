import { afterEach, describe, expect, it, vi } from 'vitest'
import { SwapperMode, type SwapApiQuote } from '~/entities/swap'
import {
  applySlippageToInput,
  applySlippageToOutput,
  validateSwapQuoteSlippageData,
} from '~/composables/useEulerOperations/swaps/verify'

const makeQuote = (overrides: Partial<SwapApiQuote>): SwapApiQuote => ({
  amountIn: '1000',
  amountInMax: '1000',
  amountOut: '950',
  amountOutMin: '945',
  route: [{ providerName: 'test-provider' }],
  ...overrides,
}) as SwapApiQuote

describe('swap quote slippage validation', () => {
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('rounds output slippage down like the SDK', () => {
    expect(applySlippageToOutput(950n, 0.5)).toBe(945n)
  })

  it('rounds input slippage up like the SDK', () => {
    expect(applySlippageToInput(1000n, 0.5)).toBe(1005n)
  })

  it('rejects invalid requested slippage', () => {
    expect(() =>
      validateSwapQuoteSlippageData(
        { slippage: 51, swapperMode: SwapperMode.EXACT_IN },
        makeQuote({}),
      ),
    ).toThrow('Valid slippage between 0 and 50% must be provided for swap')
  })

  it('rejects amountOutMin below requested slippage', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() =>
      validateSwapQuoteSlippageData(
        { slippage: 0.5, swapperMode: SwapperMode.EXACT_IN },
        makeQuote({ amountOutMin: '944' }),
      ),
    ).toThrow('amountOutMin exceeds requested slippage')

    expect(warnSpy).toHaveBeenCalledWith(
      '[swapQuoteSlippage] Swap quote exceeds requested slippage',
      expect.objectContaining({
        actualSlippage: '0.6315%',
        checkedAmount: '944',
        expectedAmount: '945',
        field: 'amountOutMin',
        mode: 'output',
        requestedSlippage: '0.5%',
        route: 'test-provider',
      }),
    )
    expect(warnSpy.mock.calls[0]?.[1]).not.toHaveProperty('quote')
    expect(warnSpy.mock.calls[0]?.[1]).not.toHaveProperty('fullQuote')
  })

  it('rejects amountInMax above requested slippage for target debt', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    expect(() =>
      validateSwapQuoteSlippageData(
        { slippage: 0.5, swapperMode: SwapperMode.TARGET_DEBT },
        makeQuote({ amountInMax: '1007' }),
      ),
    ).toThrow('amountInMax exceeds requested slippage')

    expect(warnSpy).toHaveBeenCalledWith(
      '[swapQuoteSlippage] Swap quote exceeds requested slippage',
      expect.objectContaining({
        actualSlippage: '0.7000%',
        checkedAmount: '1007',
        expectedAmount: '1006',
        field: 'amountInMax',
        mode: 'input',
        requestedSlippage: '0.5%',
        route: 'test-provider',
      }),
    )
    expect(warnSpy.mock.calls[0]?.[1]).not.toHaveProperty('quote')
    expect(warnSpy.mock.calls[0]?.[1]).not.toHaveProperty('fullQuote')
  })

  it('allows output slippage up to the monorepo divergence allowance', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    expect(() =>
      validateSwapQuoteSlippageData(
        { slippage: 0.5, swapperMode: SwapperMode.EXACT_IN },
        makeQuote({ amountOut: '2000000', amountOutMin: '1989999' }),
      ),
    ).not.toThrow()

    expect(infoSpy).toHaveBeenCalledWith(
      '[swapQuoteSlippage] Swap quote slippage validation',
      expect.objectContaining({
        actualSlippage: '0.5000%',
        checkedAmount: '1989999',
        expectedAmount: '1989999',
        field: 'amountOutMin',
        requestedSlippage: '0.5%',
        route: 'test-provider',
        status: 'passed',
      }),
    )
    expect(infoSpy.mock.calls[0]?.[1]).not.toHaveProperty('quote')
    expect(infoSpy.mock.calls[0]?.[1]).not.toHaveProperty('fullQuote')
  })

  it('allows input slippage up to the monorepo divergence allowance', () => {
    const infoSpy = vi.spyOn(console, 'info').mockImplementation(() => {})

    expect(() =>
      validateSwapQuoteSlippageData(
        { slippage: 0.5, swapperMode: SwapperMode.TARGET_DEBT },
        makeQuote({ amountIn: '2000000', amountInMax: '2010001' }),
      ),
    ).not.toThrow()

    expect(infoSpy).toHaveBeenCalledWith(
      '[swapQuoteSlippage] Swap quote slippage validation',
      expect.objectContaining({
        actualSlippage: '0.5000%',
        checkedAmount: '2010001',
        expectedAmount: '2010001',
        field: 'amountInMax',
        requestedSlippage: '0.5%',
        route: 'test-provider',
        status: 'passed',
      }),
    )
    expect(infoSpy.mock.calls[0]?.[1]).not.toHaveProperty('quote')
    expect(infoSpy.mock.calls[0]?.[1]).not.toHaveProperty('fullQuote')
  })
})
