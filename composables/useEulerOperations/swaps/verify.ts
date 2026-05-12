import type { Address } from 'viem'
import { encodeFunctionData } from 'viem'
import { adjustForInterest } from '../helpers'
import { swapVerifierAbi } from '~/entities/euler/abis'
import { MAX_SLIPPAGE } from '~/entities/constants'
import { type SwapApiQuote, type SwapApiQuoteRequestContext, SwapperMode, SwapVerificationType } from '~/entities/swap'
import { logWarn } from '~/utils/errorHandling'

// Absolute extra slippage (in percentage points) the validator forgives to absorb
// BigInt rounding between the swap API and the SDK. Keep this intentionally tiny
// so accepted verifier bounds cannot drift materially beyond the selected tolerance.
const VALIDATION_DIVERGENCE_TOLERANCE_PP = 0.001

type SwapQuoteSlippageValidationContext = {
  actualSlippage: string
  expectedAmount: bigint
  field: 'amountInMax' | 'amountOutMin'
  mode: 'input' | 'output'
  quote: SwapApiQuote
  quoteSlippage: number | undefined
  requestedSlippage: number
}

type SwapQuoteSlippageLogSummary = {
  actualSlippage: string
  amountIn: string
  amountInMax: string
  amountOut: string
  amountOutMin: string
  checkedAmount: string
  expectedAmount: string
  field: 'amountInMax' | 'amountOutMin'
  mode: 'input' | 'output'
  quoteSlippage?: string
  requestedSlippage: string
  route?: string
  status: 'failed' | 'passed'
  fullQuote?: SwapApiQuote
}

export const getSwapInputAmount = (quote: SwapApiQuote, swapperMode: SwapperMode) => {
  const amountIn = BigInt(quote.amountIn || 0)
  const amountInMax = BigInt(quote.amountInMax || 0)
  if (swapperMode === SwapperMode.EXACT_IN) return amountIn
  return amountInMax > 0n ? amountInMax : amountIn
}

export function validateSwapQuoteSlippageData(
  request: { slippage?: number, swapperMode?: SwapperMode },
  quote: SwapApiQuote,
): void {
  const { slippage } = request

  if (
    slippage === undefined
    || !Number.isFinite(slippage)
    || slippage > MAX_SLIPPAGE
    || slippage < 0
  ) {
    throw new Error('Valid slippage between 0 and 50% must be provided for swap')
  }

  if (request.swapperMode === SwapperMode.TARGET_DEBT) {
    const amountIn = BigInt(quote.amountIn || 0)
    const amountInMax = BigInt(quote.amountInMax || 0)
    const expectedAmountInMax = applySlippageToInputWithDivergence(amountIn, slippage)
    const validationContext = {
      actualSlippage: calculateInputSlippagePercent(amountIn, amountInMax),
      expectedAmount: expectedAmountInMax,
      field: 'amountInMax' as const,
      mode: 'input' as const,
      quote,
      quoteSlippage: quote.slippage,
      requestedSlippage: slippage,
    }

    if (amountInMax > expectedAmountInMax) {
      logSwapQuoteSlippageValidation('failed', validationContext)
      throw new Error('Swap quote amountInMax exceeds requested slippage')
    }

    logSwapQuoteSlippageValidation('passed', validationContext)
    return
  }

  const amountOut = BigInt(quote.amountOut || 0)
  const amountOutMin = BigInt(quote.amountOutMin || 0)
  const expectedAmountOutMin = applySlippageToOutputWithDivergence(amountOut, slippage)
  const validationContext = {
    actualSlippage: calculateOutputSlippagePercent(amountOut, amountOutMin),
    expectedAmount: expectedAmountOutMin,
    field: 'amountOutMin' as const,
    mode: 'output' as const,
    quote,
    quoteSlippage: quote.slippage,
    requestedSlippage: slippage,
  }

  if (amountOutMin < expectedAmountOutMin) {
    logSwapQuoteSlippageValidation('failed', validationContext)
    throw new Error('Swap quote amountOutMin exceeds requested slippage')
  }

  logSwapQuoteSlippageValidation('passed', validationContext)
}

export function applySlippageToOutput(amount: bigint, slippage: number): bigint {
  const { slippageUnits, denominator } = parseSlippagePercent(slippage)
  return (amount * (denominator - slippageUnits)) / denominator
}

export function applySlippageToInput(amount: bigint, slippage: number): bigint {
  const { slippageUnits, denominator } = parseSlippagePercent(slippage)
  return (amount * (denominator + slippageUnits) + denominator - 1n) / denominator
}

function applySlippageToOutputWithDivergence(amount: bigint, slippage: number): bigint {
  return applySlippageToOutput(amount, slippage + VALIDATION_DIVERGENCE_TOLERANCE_PP)
}

function applySlippageToInputWithDivergence(amount: bigint, slippage: number): bigint {
  return applySlippageToInput(amount, slippage + VALIDATION_DIVERGENCE_TOLERANCE_PP)
}

function parseSlippagePercent(slippage: number): {
  slippageUnits: bigint
  denominator: bigint
} {
  const slippageString = slippage.toLocaleString('en-US', {
    useGrouping: false,
    maximumFractionDigits: 20,
  })
  const [whole = '0', fraction = ''] = slippageString.split('.')
  const scale = 10n ** BigInt(fraction.length)
  const slippageUnits = BigInt(whole) * scale + BigInt(fraction || '0')

  return {
    slippageUnits,
    denominator: 100n * scale,
  }
}

function calculateOutputSlippagePercent(amountOut: bigint, amountOutMin: bigint): string {
  if (amountOut <= 0n) return 'unavailable'

  return formatPercentRatio(amountOut - amountOutMin, amountOut)
}

function calculateInputSlippagePercent(amountIn: bigint, amountInMax: bigint): string {
  if (amountIn <= 0n) return 'unavailable'

  return formatPercentRatio(amountInMax - amountIn, amountIn)
}

function formatPercentRatio(numerator: bigint, denominator: bigint): string {
  const scale = 10_000n
  const scaledPercent = (numerator * 100n * scale) / denominator
  const whole = scaledPercent / scale
  const fraction = (scaledPercent % scale).toString().padStart(4, '0')

  return `${whole}.${fraction}%`
}

function logSwapQuoteSlippageValidation(
  status: 'failed' | 'passed',
  {
    actualSlippage,
    expectedAmount,
    field,
    mode,
    quote,
    quoteSlippage,
    requestedSlippage,
  }: SwapQuoteSlippageValidationContext,
) {
  const payload: SwapQuoteSlippageLogSummary = {
    actualSlippage,
    amountIn: quote.amountIn,
    amountInMax: quote.amountInMax,
    amountOut: quote.amountOut,
    amountOutMin: quote.amountOutMin,
    checkedAmount: quote[field],
    expectedAmount: expectedAmount.toString(),
    field,
    mode,
    quoteSlippage: quoteSlippage === undefined ? undefined : `${quoteSlippage}%`,
    requestedSlippage: `${requestedSlippage}%`,
    route: quote.route?.map(item => item.providerName).join(', ') || undefined,
    status,
  }

  if (status !== 'failed') return

  if (isDevRuntime() && shouldLogFullSwapQuote()) {
    payload.fullQuote = quote
  }

  logWarn('swapQuoteSlippage', 'Swap quote exceeds requested slippage', { data: payload })
}

function isDevRuntime() {
  return import.meta.env?.DEV === true
}

function shouldLogFullSwapQuote() {
  if (typeof localStorage === 'undefined' || typeof localStorage.getItem !== 'function') return false
  return localStorage.getItem('debug-swap-quotes') === 'true'
}

export function getSwapVerifierExpectedContext(quote: SwapApiQuote): SwapApiQuoteRequestContext {
  if (!quote.requestContext) {
    throw new Error('Swap quote request context missing')
  }

  return quote.requestContext
}

function getQuoteTokenAddress(quote: SwapApiQuote, field: 'tokenIn' | 'tokenOut'): Address {
  const address = quote[field].address || quote[field].addressInfo
  if (!address) {
    throw new Error(`Swap quote ${field} address missing`)
  }

  return address
}

function assertSameAddress(field: string, actual: Address, expected: Address) {
  if (actual.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`Swap quote ${field} mismatch`)
  }
}

function assertSameDeadline(actual: number, expected: number) {
  if (actual !== expected) {
    throw new Error('Swap quote deadline mismatch')
  }
}

function validateSwapQuoteRequestIntent({
  quote,
  expectedContext,
  swapperMode,
  isRepay,
  targetDebt,
  currentDebt,
}: {
  quote: SwapApiQuote
  expectedContext: SwapApiQuoteRequestContext
  swapperMode: SwapperMode
  isRepay: boolean
  targetDebt: bigint
  currentDebt: bigint
}) {
  if (swapperMode !== expectedContext.swapperMode) {
    throw new Error('Swap quote mode mismatch')
  }
  if (isRepay !== expectedContext.isRepay) {
    throw new Error('Swap quote repay intent mismatch')
  }
  if (targetDebt !== expectedContext.targetDebt) {
    throw new Error('Swap quote target debt mismatch')
  }
  if (currentDebt !== expectedContext.currentDebt) {
    throw new Error('Swap quote current debt mismatch')
  }

  if (expectedContext.swapperMode === SwapperMode.EXACT_IN) {
    const amountIn = BigInt(quote.amountIn || 0)
    if (amountIn !== expectedContext.amount) {
      throw new Error('Swap quote amountIn mismatch')
    }
    return
  }

  const amountOut = BigInt(quote.amountOut || 0)
  if (amountOut !== expectedContext.amount) {
    throw new Error('Swap quote amountOut mismatch')
  }
}

function validateSwapVerifierContext({
  quote,
  expectedContext,
  amount,
  validateVerifierAccount,
}: {
  quote: SwapApiQuote
  expectedContext: SwapApiQuoteRequestContext
  amount: bigint
  validateVerifierAccount: boolean
}) {
  assertSameAddress('tokenIn', getQuoteTokenAddress(quote, 'tokenIn'), expectedContext.tokenIn)
  assertSameAddress('tokenOut', getQuoteTokenAddress(quote, 'tokenOut'), expectedContext.tokenOut)
  assertSameAddress('accountIn', quote.accountIn, expectedContext.accountIn)
  assertSameAddress('accountOut', quote.accountOut, expectedContext.accountOut)
  assertSameAddress('vaultIn', quote.vaultIn, expectedContext.vaultIn)
  assertSameAddress('receiver', quote.receiver, expectedContext.receiver)
  assertSameAddress('verifier', quote.verify.verifierAddress, expectedContext.verifierAddress)
  assertSameAddress('swapper', quote.swap.swapperAddress, expectedContext.swapperAddress)
  assertSameAddress('verify.vault', quote.verify.vault, expectedContext.receiver)
  if (validateVerifierAccount) {
    assertSameAddress('verify.account', quote.verify.account, expectedContext.accountOut)
  }
  assertSameDeadline(quote.verify.deadline, expectedContext.deadline)

  if (BigInt(quote.verify.amount || 0) !== amount) {
    throw new Error('Swap quote verify amount mismatch')
  }
}

export const buildSwapVerifierData = ({
  quote,
  expectedContext,
  swapperMode,
  isRepay,
  requestedSlippage,
  targetDebt = 0n,
  currentDebt = 0n,
}: {
  quote: SwapApiQuote
  expectedContext: SwapApiQuoteRequestContext
  swapperMode: SwapperMode
  isRepay: boolean
  requestedSlippage: number
  targetDebt?: bigint
  currentDebt?: bigint
}) => {
  validateSwapQuoteRequestIntent({
    quote,
    expectedContext,
    swapperMode,
    isRepay,
    targetDebt,
    currentDebt,
  })
  validateSwapQuoteSlippageData({ slippage: requestedSlippage, swapperMode }, quote)

  let functionName: 'verifyAmountMinAndSkim' | 'verifyAmountMinAndTransfer' | 'verifyDebtMax'
  let amount: bigint

  if (isRepay) {
    functionName = 'verifyDebtMax'
    if (swapperMode === SwapperMode.TARGET_DEBT) {
      amount = targetDebt
    }
    else {
      amount = currentDebt - BigInt(quote.amountOutMin || 0)
      if (amount < 0n) amount = 0n
      amount = adjustForInterest(amount)
    }
  }
  else if (quote.verify.type === SwapVerificationType.TransferMin) {
    functionName = 'verifyAmountMinAndTransfer'
    amount = BigInt(quote.amountOutMin || 0)
    validateSwapVerifierContext({
      quote,
      expectedContext,
      amount,
      validateVerifierAccount: false,
    })

    // verifyAmountMinAndTransfer(token, receiver, amountMin, deadline)
    return encodeFunctionData({
      abi: swapVerifierAbi,
      functionName,
      args: [expectedContext.tokenOut, expectedContext.receiver, amount, BigInt(expectedContext.deadline || 0)],
    })
  }
  else {
    functionName = 'verifyAmountMinAndSkim'
    amount = BigInt(quote.amountOutMin || 0)
  }

  validateSwapVerifierContext({
    quote,
    expectedContext,
    amount,
    validateVerifierAccount: true,
  })

  // SkimMin: verifyAmountMinAndSkim(vault, receiver, amountMin, deadline)
  // DebtMax: verifyDebtMax(vault, account, amountMax, deadline)
  return encodeFunctionData({
    abi: swapVerifierAbi,
    functionName,
    args: [expectedContext.receiver, expectedContext.accountOut, amount, BigInt(expectedContext.deadline || 0)],
  })
}
