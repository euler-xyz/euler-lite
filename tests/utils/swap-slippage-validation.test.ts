import { describe, expect, it } from 'vitest'
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

const captureStdout = () => {
  const captured: string[] = []
  const originalWrite = process.stdout.write.bind(process.stdout)
  process.stdout.write = ((chunk: unknown) => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk as Uint8Array).toString())
    return true
  }) as typeof process.stdout.write

  return {
    restore: () => {
      process.stdout.write = originalWrite
    },
    lines: () => captured.join('')
      .split('\n')
      .map(line => line.trim())
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [JSON.parse(line) as Record<string, unknown>]
        }
        catch {
          return []
        }
      }),
  }
}

const validationLogLines = (capture: ReturnType<typeof captureStdout>) =>
  capture.lines().filter(line => line.ctx === 'swapQuoteSlippage')

describe('swap quote slippage validation', () => {
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
    const stdout = captureStdout()

    try {
      expect(() =>
        validateSwapQuoteSlippageData(
          { slippage: 0.5, swapperMode: SwapperMode.EXACT_IN },
          makeQuote({ amountOutMin: '944' }),
        ),
      ).toThrow('amountOutMin exceeds requested slippage')

      const lines = validationLogLines(stdout)
      expect(lines).toHaveLength(1)
      const line = lines[0]
      expect(line).toMatchObject({
        ctx: 'swapQuoteSlippage',
        msg: 'Swap quote exceeds requested slippage',
        data: expect.objectContaining({
          actualSlippage: '0.6315%',
          checkedAmount: '944',
          expectedAmount: '945',
          field: 'amountOutMin',
          mode: 'output',
          requestedSlippage: '0.5%',
          route: 'test-provider',
        }),
      })
      expect(line.data).not.toHaveProperty('quote')
      expect(line.data).not.toHaveProperty('fullQuote')
    }
    finally {
      stdout.restore()
    }
  })

  it('rejects amountInMax above requested slippage for target debt', () => {
    const stdout = captureStdout()

    try {
      expect(() =>
        validateSwapQuoteSlippageData(
          { slippage: 0.5, swapperMode: SwapperMode.TARGET_DEBT },
          makeQuote({ amountInMax: '1007' }),
        ),
      ).toThrow('amountInMax exceeds requested slippage')

      const lines = validationLogLines(stdout)
      expect(lines).toHaveLength(1)
      const line = lines[0]
      expect(line).toMatchObject({
        ctx: 'swapQuoteSlippage',
        msg: 'Swap quote exceeds requested slippage',
        data: expect.objectContaining({
          actualSlippage: '0.7000%',
          checkedAmount: '1007',
          expectedAmount: '1006',
          field: 'amountInMax',
          mode: 'input',
          requestedSlippage: '0.5%',
          route: 'test-provider',
        }),
      })
      expect(line.data).not.toHaveProperty('quote')
      expect(line.data).not.toHaveProperty('fullQuote')
    }
    finally {
      stdout.restore()
    }
  })

  it('allows output slippage up to the validator divergence tolerance', () => {
    const stdout = captureStdout()

    try {
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

      const lines = validationLogLines(stdout)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({
        data: expect.objectContaining({
          checkedAmount: '1989979',
          field: 'amountOutMin',
          status: 'failed',
        }),
      })
    }
    finally {
      stdout.restore()
    }
  })

  it('allows input slippage up to the validator divergence tolerance', () => {
    const stdout = captureStdout()

    try {
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

      const lines = validationLogLines(stdout)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({
        data: expect.objectContaining({
          checkedAmount: '2010021',
          field: 'amountInMax',
          status: 'failed',
        }),
      })
    }
    finally {
      stdout.restore()
    }
  })

  it('keeps validator divergence tolerance tiny at MAX_SLIPPAGE', () => {
    const stdout = captureStdout()

    // At MAX_SLIPPAGE = 50%, the validator forgives 0.001pp for rounding:
    // boundary amountOutMin = floor(2_000_000 * (1 - 0.50001)) = 999_980.
    try {
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

      const lines = validationLogLines(stdout)
      expect(lines).toHaveLength(1)
      expect(lines[0]).toMatchObject({
        data: expect.objectContaining({
          checkedAmount: '999979',
          field: 'amountOutMin',
          status: 'failed',
        }),
      })
    }
    finally {
      stdout.restore()
    }
  })
})
