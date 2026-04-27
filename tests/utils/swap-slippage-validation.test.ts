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
      '[swapQuoteSlippage]',
      'Swap quote exceeds requested slippage',
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
    expect(warnSpy.mock.calls[0]?.[2]).not.toHaveProperty('quote')
    expect(warnSpy.mock.calls[0]?.[2]).not.toHaveProperty('fullQuote')
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
      '[swapQuoteSlippage]',
      'Swap quote exceeds requested slippage',
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
    expect(warnSpy.mock.calls[0]?.[2]).not.toHaveProperty('quote')
    expect(warnSpy.mock.calls[0]?.[2]).not.toHaveProperty('fullQuote')
  })

  it('allows output slippage up to the validator divergence tolerance', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // At slippage 0.5%, validator forgives up to +0.001pp absolute, so a quote
    // with amountOutMin = floor(2_000_000 * (1 - 0.00501)) = 1989980 must pass.
    expect(() =>
      validateSwapQuoteSlippageData(
        { slippage: 0.5, swapperMode: SwapperMode.EXACT_IN },
        makeQuote({ amountOut: '2000000', amountOutMin: '1989980' }),
      ),
    ).not.toThrow()

    // One wei below the boundary must fail.
    expect(() =>
      validateSwapQuoteSlippageData(
        { slippage: 0.5, swapperMode: SwapperMode.EXACT_IN },
        makeQuote({ amountOut: '2000000', amountOutMin: '1989979' }),
      ),
    ).toThrow('amountOutMin exceeds requested slippage')

    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('allows input slippage up to the validator divergence tolerance', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    // At slippage 0.5%, validator forgives up to +0.001pp absolute, so a quote
    // with amountInMax = floor(2_000_000 * (1 + 0.00501)) = 2010020 must pass.
    expect(() =>
      validateSwapQuoteSlippageData(
        { slippage: 0.5, swapperMode: SwapperMode.TARGET_DEBT },
        makeQuote({ amountIn: '2000000', amountInMax: '2010020' }),
      ),
    ).not.toThrow()

    // One wei above the boundary must fail.
    expect(() =>
      validateSwapQuoteSlippageData(
        { slippage: 0.5, swapperMode: SwapperMode.TARGET_DEBT },
        makeQuote({ amountIn: '2000000', amountInMax: '2010021' }),
      ),
    ).toThrow('amountInMax exceeds requested slippage')

    expect(warnSpy).toHaveBeenCalledTimes(1)
  })

  it('keeps validator tolerance below SwapDetailsSummary warning threshold at MAX_SLIPPAGE', () => {
    // SLIPPAGE_DIFF_TOLERANCE in SwapDetailsSummary is 0.005pp. The validator
    // must allow strictly less so a quote it accepts never trips the user-facing
    // warning. At MAX_SLIPPAGE = 50%, the validator forgives 0.001pp → boundary
    // amountOutMin = floor(2_000_000 * (1 - 0.50001)) = 999_980.
    expect(() =>
      validateSwapQuoteSlippageData(
        { slippage: 50, swapperMode: SwapperMode.EXACT_IN },
        makeQuote({ amountOut: '2000000', amountOutMin: '999980' }),
      ),
    ).not.toThrow()

    expect(() =>
      validateSwapQuoteSlippageData(
        { slippage: 50, swapperMode: SwapperMode.EXACT_IN },
        makeQuote({ amountOut: '2000000', amountOutMin: '999979' }),
      ),
    ).toThrow('amountOutMin exceeds requested slippage')
  })
})
