import { describe, expect, it } from 'vitest'
import { encodeFunctionData, type Address } from 'viem'
import { SwapperMode, SwapVerificationType, type SwapApiQuote, type SwapApiQuoteRequestContext } from '~/entities/swap'
import { swapVerifierAbi } from '~/entities/euler/abis'
import {
  applySlippageToInput,
  applySlippageToOutput,
  buildSwapVerifierData,
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

const TEST_CONTEXT: SwapApiQuoteRequestContext = {
  tokenIn: '0x0000000000000000000000000000000000000001',
  tokenOut: '0x0000000000000000000000000000000000000002',
  accountIn: '0x0000000000000000000000000000000000000003',
  accountOut: '0x0000000000000000000000000000000000000004',
  amount: 1000n,
  vaultIn: '0x0000000000000000000000000000000000000005',
  receiver: '0x0000000000000000000000000000000000000006',
  swapperMode: SwapperMode.EXACT_IN,
  isRepay: false,
  targetDebt: 0n,
  currentDebt: 0n,
  deadline: 1_800_000_000,
  verifierAddress: '0x0000000000000000000000000000000000000007',
  swapperAddress: '0x0000000000000000000000000000000000000008',
}

const makeContext = (overrides: Partial<SwapApiQuoteRequestContext> = {}): SwapApiQuoteRequestContext => ({
  ...TEST_CONTEXT,
  ...overrides,
})

const encodeVerifierData = (
  type: SwapVerificationType,
  amount: bigint,
  context: SwapApiQuoteRequestContext = TEST_CONTEXT,
) => {
  if (type === SwapVerificationType.TransferMin) {
    return encodeFunctionData({
      abi: swapVerifierAbi,
      functionName: 'verifyAmountMinAndTransfer',
      args: [context.tokenOut, context.receiver, amount, BigInt(context.deadline)],
    })
  }

  return encodeFunctionData({
    abi: swapVerifierAbi,
    functionName: type === SwapVerificationType.DebtMax ? 'verifyDebtMax' : 'verifyAmountMinAndSkim',
    args: [context.receiver, context.accountOut, amount, BigInt(context.deadline)],
  })
}

const makeVerifierQuote = (
  type: SwapVerificationType,
  overrides: Partial<SwapApiQuote> = {},
): SwapApiQuote => {
  const amount = type === SwapVerificationType.DebtMax ? 500n : 945n
  const context = overrides.requestContext ?? (type === SwapVerificationType.DebtMax
    ? makeContext({
        amount: 500n,
        swapperMode: SwapperMode.TARGET_DEBT,
        isRepay: true,
        targetDebt: 500n,
        currentDebt: 1000n,
      })
    : TEST_CONTEXT)

  return {
    amountIn: '1000',
    amountInMax: '1000',
    amountOut: type === SwapVerificationType.DebtMax ? '500' : '950',
    amountOutMin: type === SwapVerificationType.DebtMax ? '500' : '945',
    accountIn: context.accountIn,
    accountOut: context.accountOut,
    vaultIn: context.vaultIn,
    receiver: context.receiver,
    tokenIn: {
      address: context.tokenIn,
      chainId: 1,
      decimals: 18,
      logoURI: '',
      name: 'Input',
      symbol: 'IN',
    },
    tokenOut: {
      address: context.tokenOut,
      chainId: 1,
      decimals: 18,
      logoURI: '',
      name: 'Output',
      symbol: 'OUT',
    },
    slippage: 0.5,
    swap: {
      swapperAddress: context.swapperAddress,
      swapperData: '0x',
      multicallItems: [],
    },
    verify: {
      verifierAddress: context.verifierAddress,
      verifierData: encodeVerifierData(type, amount, context),
      type,
      vault: context.receiver,
      account: context.accountOut,
      amount: amount.toString(),
      deadline: context.deadline,
    },
    route: [{ providerName: 'test-provider' }],
    requestContext: context,
    ...overrides,
  }
}

const captureStdout = () => {
  const captured: string[] = []
  const originalWrite = process.stdout.write
  process.stdout.write = ((
    chunk: string | Uint8Array,
    encodingOrCallback?: BufferEncoding | ((error?: Error | null) => void),
    callback?: (error?: Error | null) => void,
  ) => {
    captured.push(typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString())
    const writeCallback = typeof encodingOrCallback === 'function' ? encodingOrCallback : callback
    writeCallback?.()
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

const withCapturedStdout = <T>(callback: (stdout: ReturnType<typeof captureStdout>) => T): T => {
  const stdout = captureStdout()
  try {
    return callback(stdout)
  }
  finally {
    stdout.restore()
  }
}

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

  it('rejects amountOutMin below requested slippage', () =>
    withCapturedStdout((stdout) => {
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
        level: 'warn',
        app: 'euler-lite',
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
    }))

  it('rejects amountInMax above requested slippage for target debt', () =>
    withCapturedStdout((stdout) => {
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
        level: 'warn',
        app: 'euler-lite',
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
    }))

  it('allows output slippage up to the validator divergence tolerance', () =>
    withCapturedStdout((stdout) => {
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
    }))

  it('allows input slippage up to the validator divergence tolerance', () =>
    withCapturedStdout((stdout) => {
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
    }))

  it('keeps validator tolerance below SwapDetailsSummary warning threshold at MAX_SLIPPAGE', () =>
    withCapturedStdout((stdout) => {
      // SLIPPAGE_DIFF_TOLERANCE in SwapDetailsSummary is 0.005pp. The validator
      // must allow strictly less so a quote it accepts never trips the user-facing
      // warning. At MAX_SLIPPAGE = 50%, the validator forgives 0.001pp:
      // boundary amountOutMin = floor(2_000_000 * (1 - 0.50001)) = 999_980.
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
    }))
})

describe('swap verifier context validation', () => {
  it.each([
    [SwapVerificationType.TransferMin, false, SwapperMode.EXACT_IN, 0n],
    [SwapVerificationType.SkimMin, false, SwapperMode.EXACT_IN, 0n],
    [SwapVerificationType.DebtMax, true, SwapperMode.TARGET_DEBT, 500n],
  ])('builds %s verifier calldata from expected request context', (
    type,
    isRepay,
    swapperMode,
    targetDebt,
  ) => {
    const quote = makeVerifierQuote(type)

    const verifierData = buildSwapVerifierData({
      quote,
      expectedContext: quote.requestContext!,
      swapperMode,
      isRepay,
      requestedSlippage: 0.5,
      currentDebt: quote.requestContext!.currentDebt,
      targetDebt,
    })

    expect(verifierData.toLowerCase()).toBe(quote.verify.verifierData.toLowerCase())
  })

  it('rejects transfer verifier calldata redirected away from the requested receiver', () => {
    const quote = makeVerifierQuote(SwapVerificationType.TransferMin)
    const badReceiver = '0x0000000000000000000000000000000000000009' as Address
    const maliciousContext = { ...TEST_CONTEXT, receiver: badReceiver }
    quote.verify = {
      ...quote.verify,
      vault: badReceiver,
      verifierData: encodeVerifierData(SwapVerificationType.TransferMin, 945n, maliciousContext),
    }

    expect(() =>
      buildSwapVerifierData({
        quote,
        expectedContext: TEST_CONTEXT,
        swapperMode: SwapperMode.EXACT_IN,
        isRepay: false,
        requestedSlippage: 0.5,
      }),
    ).toThrow('Swap quote verify.vault mismatch')
  })

  it('rejects skim verifier calldata redirected away from the requested account', () => {
    const quote = makeVerifierQuote(SwapVerificationType.SkimMin)
    const badAccount = '0x0000000000000000000000000000000000000009' as Address
    const maliciousContext = { ...TEST_CONTEXT, accountOut: badAccount }
    quote.verify = {
      ...quote.verify,
      account: badAccount,
      verifierData: encodeVerifierData(SwapVerificationType.SkimMin, 945n, maliciousContext),
    }

    expect(() =>
      buildSwapVerifierData({
        quote,
        expectedContext: TEST_CONTEXT,
        swapperMode: SwapperMode.EXACT_IN,
        isRepay: false,
        requestedSlippage: 0.5,
      }),
    ).toThrow('Swap quote verify.account mismatch')
  })

  it('rejects debt verifier quotes that use an unexpected swapper', () => {
    const quote = makeVerifierQuote(SwapVerificationType.DebtMax)
    quote.swap = {
      ...quote.swap,
      swapperAddress: '0x0000000000000000000000000000000000000009',
    }

    expect(() =>
      buildSwapVerifierData({
        quote,
        expectedContext: quote.requestContext!,
        swapperMode: SwapperMode.TARGET_DEBT,
        isRepay: true,
        requestedSlippage: 0.5,
        currentDebt: 1000n,
        targetDebt: 500n,
      }),
    ).toThrow('Swap quote swapper mismatch')
  })

  it('rejects exact-in quotes that change the requested input amount', () => {
    const quote = makeVerifierQuote(SwapVerificationType.SkimMin, { amountIn: '1001' })

    expect(() =>
      buildSwapVerifierData({
        quote,
        expectedContext: TEST_CONTEXT,
        swapperMode: SwapperMode.EXACT_IN,
        isRepay: false,
        requestedSlippage: 0.5,
      }),
    ).toThrow('Swap quote amountIn mismatch')
  })

  it('rejects target-debt quotes that change the requested output amount', () => {
    const quote = makeVerifierQuote(SwapVerificationType.DebtMax, { amountOut: '501' })

    expect(() =>
      buildSwapVerifierData({
        quote,
        expectedContext: quote.requestContext!,
        swapperMode: SwapperMode.TARGET_DEBT,
        isRepay: true,
        requestedSlippage: 0.5,
        currentDebt: 1000n,
        targetDebt: 500n,
      }),
    ).toThrow('Swap quote amountOut mismatch')
  })
})
