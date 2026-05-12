import { encodeFunctionData, getAddress, zeroAddress, type Address } from 'viem'
import { adjustForInterest } from '../helpers'
import { swapVerifierAbi } from '~/entities/euler/abis'
import { MAX_SLIPPAGE, SWAP_DEFAULT_DEADLINE_SECONDS } from '~/entities/constants'
import { type SwapApiQuote, SwapperMode, SwapVerificationType } from '~/entities/swap'
import { logWarn } from '~/utils/errorHandling'
import { assertSwapperVerifierAllowed } from '~/utils/swap-validation'

// Absolute extra slippage (in percentage points) the validator forgives to absorb
// BigInt rounding between the swap API and the SDK. Keep this intentionally tiny
// so accepted verifier bounds cannot drift materially beyond the selected tolerance.
const VALIDATION_DIVERGENCE_TOLERANCE_PP = 0.001
const DEADLINE_VALIDATION_TOLERANCE_SECONDS = 60

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

export type WalletSwapRepayQuoteValidationContext = {
  expectedAccountOut: Address
  expectedReceiver: Address
  expectedSwapperAddress: Address | undefined
  expectedTokenIn: Address
  expectedTokenOut: Address
  expectedVerifierAddress: Address | undefined
  expectedInputAmount?: bigint
  requestedSlippage: number
  swapperMode: SwapperMode
  targetDebt: bigint
  currentDebt: bigint
  nowTimestamp?: number
}

const normalizeAddress = (value: string | undefined, field: string) => {
  if (!value) {
    throw new Error(`Swap quote missing ${field}`)
  }
  try {
    return getAddress(value)
  }
  catch {
    throw new Error(`Swap quote invalid ${field}`)
  }
}

const assertQuoteAddress = (
  actual: string | undefined,
  expected: string,
  field: string,
) => {
  if (normalizeAddress(actual, field) !== normalizeAddress(expected, `expected ${field}`)) {
    throw new Error(`Swap quote ${field} mismatch`)
  }
}

const parseQuoteBigInt = (value: string | number | bigint | undefined, field: string) => {
  try {
    return BigInt(value ?? '')
  }
  catch {
    throw new Error(`Swap quote invalid ${field}`)
  }
}

export const getSwapRepayVerifierAmount = ({
  quote,
  swapperMode,
  targetDebt,
  currentDebt,
}: {
  quote: SwapApiQuote
  swapperMode: SwapperMode
  targetDebt: bigint
  currentDebt: bigint
}) => {
  if (swapperMode === SwapperMode.TARGET_DEBT) {
    return targetDebt
  }

  let amount = currentDebt - BigInt(quote.amountOutMin || 0)
  if (amount < 0n) amount = 0n
  return adjustForInterest(amount)
}

export function validateWalletSwapRepayQuote(
  quote: SwapApiQuote,
  context: WalletSwapRepayQuoteValidationContext,
): void {
  if (!quote.tokenIn) {
    throw new Error('Swap quote missing tokenIn')
  }
  if (!quote.tokenOut) {
    throw new Error('Swap quote missing tokenOut')
  }
  if (!quote.swap) {
    throw new Error('Swap quote missing swap')
  }
  if (!quote.verify) {
    throw new Error('Swap quote missing verify')
  }
  if (!quote.verify.verifierData) {
    throw new Error('Swap quote missing verify.verifierData')
  }
  if (!quote.verify.verifierAddress) {
    throw new Error('Swap quote missing verify.verifierAddress')
  }
  if (!context.expectedSwapperAddress) {
    throw new Error('Known swapper address not configured')
  }
  assertSwapperVerifierAllowed(quote.verify.verifierAddress, context.expectedVerifierAddress)

  assertQuoteAddress(quote.tokenIn.address, context.expectedTokenIn, 'tokenIn')
  assertQuoteAddress(quote.tokenOut.address, context.expectedTokenOut, 'tokenOut')
  assertQuoteAddress(quote.accountIn, zeroAddress, 'accountIn')
  assertQuoteAddress(quote.accountOut, context.expectedAccountOut, 'accountOut')
  assertQuoteAddress(quote.vaultIn, zeroAddress, 'vaultIn')
  assertQuoteAddress(quote.receiver, context.expectedReceiver, 'receiver')
  assertQuoteAddress(quote.verify.vault, context.expectedReceiver, 'verify.vault')
  assertQuoteAddress(quote.verify.account, context.expectedAccountOut, 'verify.account')
  assertQuoteAddress(quote.swap.swapperAddress, context.expectedSwapperAddress, 'swap.swapperAddress')

  if (quote.verify.type !== SwapVerificationType.DebtMax) {
    throw new Error('Swap verifier type mismatch')
  }

  if (!Number.isSafeInteger(quote.verify.deadline) || quote.verify.deadline <= 0) {
    throw new Error('Swap quote invalid verify.deadline')
  }
  const nowTimestamp = context.nowTimestamp ?? Math.floor(Date.now() / 1000)
  if (quote.verify.deadline <= nowTimestamp) {
    throw new Error('Swap quote verify.deadline expired')
  }
  if (quote.verify.deadline > nowTimestamp + SWAP_DEFAULT_DEADLINE_SECONDS + DEADLINE_VALIDATION_TOLERANCE_SECONDS) {
    throw new Error('Swap quote verify.deadline too far in the future')
  }

  const inputAmount = getSwapInputAmount(quote, context.swapperMode)
  if (inputAmount <= 0n) {
    throw new Error('Swap quote input amount must be greater than zero')
  }
  if (context.swapperMode === SwapperMode.EXACT_IN) {
    if (context.expectedInputAmount === undefined || context.expectedInputAmount <= 0n) {
      throw new Error('Expected swap input amount must be greater than zero')
    }
    const quoteAmountIn = parseQuoteBigInt(quote.amountIn, 'amountIn')
    if (quoteAmountIn !== context.expectedInputAmount) {
      throw new Error('Swap quote amountIn mismatch')
    }
  }

  const expectedVerifierAmount = getSwapRepayVerifierAmount({
    quote,
    swapperMode: context.swapperMode,
    targetDebt: context.targetDebt,
    currentDebt: context.currentDebt,
  })
  const verifierAmount = parseQuoteBigInt(quote.verify.amount, 'verify.amount')
  if (expectedVerifierAmount > 0n && verifierAmount <= 0n) {
    throw new Error('Swap quote verify.amount must be greater than zero')
  }
  if (verifierAmount !== expectedVerifierAmount) {
    throw new Error('Swap quote verify.amount mismatch')
  }

  const verifierData = buildSwapVerifierData({
    quote,
    swapperMode: context.swapperMode,
    isRepay: true,
    requestedSlippage: context.requestedSlippage,
    targetDebt: context.targetDebt,
    currentDebt: context.currentDebt,
  })
  if (verifierData.toLowerCase() !== quote.verify.verifierData.toLowerCase()) {
    logWarn('wallet-swap-repay', 'SwapVerifier data mismatch')
    throw new Error('SwapVerifier data mismatch')
  }
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

export const buildSwapVerifierData = ({
  quote,
  swapperMode,
  isRepay,
  requestedSlippage,
  targetDebt = 0n,
  currentDebt = 0n,
}: {
  quote: SwapApiQuote
  swapperMode: SwapperMode
  isRepay: boolean
  requestedSlippage: number
  targetDebt?: bigint
  currentDebt?: bigint
}) => {
  validateSwapQuoteSlippageData({ slippage: requestedSlippage, swapperMode }, quote)

  let functionName: 'verifyAmountMinAndSkim' | 'verifyAmountMinAndTransfer' | 'verifyDebtMax'
  let amount: bigint

  if (isRepay) {
    functionName = 'verifyDebtMax'
    amount = getSwapRepayVerifierAmount({ quote, swapperMode, targetDebt, currentDebt })
  }
  else if (quote.verify.type === SwapVerificationType.TransferMin) {
    functionName = 'verifyAmountMinAndTransfer'
    amount = BigInt(quote.amountOutMin || 0)

    // verifyAmountMinAndTransfer(token, receiver, amountMin, deadline)
    // token = output token address, receiver = verify.vault (destination for the transfer)
    return encodeFunctionData({
      abi: swapVerifierAbi,
      functionName,
      args: [quote.tokenOut.address!, quote.verify.vault, amount, BigInt(quote.verify.deadline || 0)],
    })
  }
  else {
    functionName = 'verifyAmountMinAndSkim'
    amount = BigInt(quote.amountOutMin || 0)
  }

  // SkimMin: verifyAmountMinAndSkim(vault, receiver, amountMin, deadline)
  // DebtMax: verifyDebtMax(vault, account, amountMax, deadline)
  return encodeFunctionData({
    abi: swapVerifierAbi,
    functionName,
    args: [quote.verify.vault, quote.verify.account, amount, BigInt(quote.verify.deadline || 0)],
  })
}
