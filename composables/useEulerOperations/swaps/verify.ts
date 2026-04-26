import { encodeFunctionData } from 'viem'
import { adjustForInterest } from '../helpers'
import { swapVerifierAbi } from '~/entities/euler/abis'
import { MAX_SLIPPAGE } from '~/entities/constants'
import { type SwapApiQuote, SwapperMode, SwapVerificationType } from '~/entities/swap'
import { logWarn } from '~/utils/errorHandling'

// Absolute extra slippage (in percentage points) the validator forgives to absorb
// BigInt rounding between the swap API and the SDK. Must stay strictly below
// SLIPPAGE_DIFF_TOLERANCE in SwapDetailsSummary so the user-facing warning never
// fires on a quote the validator has accepted.
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
