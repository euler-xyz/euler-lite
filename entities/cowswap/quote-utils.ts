import type { SwapApiQuote } from '~/entities/swap'
import { MAX_SLIPPAGE } from '~/entities/constants'

const parseBigIntAmount = (value: unknown): bigint | undefined => {
  if (typeof value === 'bigint') {
    return value >= 0n ? value : undefined
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? BigInt(value) : undefined
  }
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    return undefined
  }
  try {
    const parsed = BigInt(value)
    return parsed >= 0n ? parsed : undefined
  }
  catch {
    return undefined
  }
}

export type CowSwapQuoteOrderAmounts = {
  sellAmount: bigint
  buyAmount: bigint
  feeAmount: bigint
}

type CowSwapQuoteSlippageTarget = 'buyAmount' | 'sellAmount'

type CowSwapQuoteOrderAmountOptions = {
  slippage?: number
  slippageTarget?: CowSwapQuoteSlippageTarget
  maxSellAmount?: bigint
}

type CowSwapQuoteOrderAmountValidationOptions = Omit<CowSwapQuoteOrderAmountOptions, 'slippage' | 'slippageTarget'> & {
  slippage: number
  slippageTarget: CowSwapQuoteSlippageTarget
  sellAmount: bigint
  buyAmount: bigint
  expectedSellAmount?: bigint
  expectedBuyAmount?: bigint
  expectedAppData?: string
  actualAppData?: string
}

const parseSlippagePercent = (slippage: number): { slippageUnits: bigint, denominator: bigint } => {
  if (!Number.isFinite(slippage) || slippage <= 0) {
    return { slippageUnits: 0n, denominator: 1n }
  }

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

const reduceBySlippage = (amount: bigint, slippage = 0): bigint => {
  const { slippageUnits, denominator } = parseSlippagePercent(slippage)
  if (slippageUnits >= denominator) return 0n
  return (amount * (denominator - slippageUnits)) / denominator
}

const increaseBySlippage = (amount: bigint, slippage = 0): bigint => {
  const { slippageUnits, denominator } = parseSlippagePercent(slippage)
  return (amount * (denominator + slippageUnits) + denominator - 1n) / denominator
}

export const getCowSwapQuoteOrderAmounts = (
  quote?: Pick<SwapApiQuote, 'providerData'> | null,
  options: CowSwapQuoteOrderAmountOptions = {},
): CowSwapQuoteOrderAmounts | undefined => {
  if (!isValidCowSwapSlippage(options.slippage)) {
    return undefined
  }

  const providerData = quote?.providerData
  const quoteSellAmount = parseBigIntAmount(providerData?.sellAmount)
  const buyAmount = parseBigIntAmount(providerData?.buyAmount)
  const feeAmount = parseBigIntAmount(providerData?.feeAmount)

  if (!quoteSellAmount || quoteSellAmount <= 0n || !buyAmount || buyAmount <= 0n || feeAmount === undefined) {
    return undefined
  }

  const orderSellAmount = quoteSellAmount + feeAmount
  const slippageAdjustedSellAmount = options.slippageTarget === 'sellAmount'
    ? increaseBySlippage(orderSellAmount, options.slippage)
    : orderSellAmount
  const adjustedSellAmount = options.maxSellAmount !== undefined && slippageAdjustedSellAmount > options.maxSellAmount
    ? options.maxSellAmount
    : slippageAdjustedSellAmount
  const adjustedBuyAmount = options.slippageTarget === 'buyAmount'
    ? reduceBySlippage(buyAmount, options.slippage)
    : buyAmount

  if (adjustedSellAmount <= 0n || adjustedBuyAmount <= 0n) {
    return undefined
  }

  return {
    sellAmount: adjustedSellAmount,
    buyAmount: adjustedBuyAmount,
    feeAmount,
  }
}

export const validateCowSwapQuoteOrderAmounts = (
  quote: Pick<SwapApiQuote, 'amountIn' | 'amountInMax' | 'amountOut' | 'amountOutMin' | 'providerData'>,
  options: CowSwapQuoteOrderAmountValidationOptions,
): CowSwapQuoteOrderAmounts => {
  assertValidCowSwapSlippage(options.slippage)

  const orderAmounts = getCowSwapQuoteOrderAmounts(quote, options)
  if (!orderAmounts) {
    throw new Error('Invalid CoW quote: missing order amounts')
  }

  if (options.sellAmount !== orderAmounts.sellAmount || options.buyAmount !== orderAmounts.buyAmount) {
    throw new Error('CoW order amounts do not match selected quote')
  }
  if (options.actualAppData !== undefined && !options.expectedAppData) {
    throw new Error('CoW quote appData is missing request binding')
  }
  if (options.expectedAppData !== undefined && options.actualAppData !== options.expectedAppData) {
    throw new Error('CoW quote appData does not match requested order')
  }

  assertCowSwapProviderAmountsMatchQuote(quote, orderAmounts, options)

  return orderAmounts
}

const isValidCowSwapSlippage = (slippage: number | undefined): boolean => (
  slippage === undefined
  || (Number.isFinite(slippage) && slippage >= 0 && slippage <= MAX_SLIPPAGE)
)

const assertValidCowSwapSlippage = (slippage: number | undefined): void => {
  if (slippage === undefined || !isValidCowSwapSlippage(slippage)) {
    throw new Error('Valid slippage between 0 and 50% must be provided for CoW swap')
  }
}

const assertCowSwapProviderAmountsMatchQuote = (
  quote: Pick<SwapApiQuote, 'amountIn' | 'amountInMax' | 'amountOut' | 'amountOutMin' | 'providerData'>,
  orderAmounts: CowSwapQuoteOrderAmounts,
  options: CowSwapQuoteOrderAmountValidationOptions,
): void => {
  const providerSellAmount = parseBigIntAmount(quote.providerData?.sellAmount)
  const providerBuyAmount = parseBigIntAmount(quote.providerData?.buyAmount)
  const providerFeeAmount = parseBigIntAmount(quote.providerData?.feeAmount)

  if (providerSellAmount === undefined || providerBuyAmount === undefined || providerFeeAmount === undefined) {
    throw new Error('Invalid CoW quote: missing order amounts')
  }

  const rawOrderSellAmount = providerSellAmount + providerFeeAmount
  if (options.expectedSellAmount !== undefined && rawOrderSellAmount !== options.expectedSellAmount) {
    throw new Error('CoW quote sell amount does not match requested amount')
  }
  if (options.expectedBuyAmount !== undefined && providerBuyAmount !== options.expectedBuyAmount) {
    throw new Error('CoW quote buy amount does not match requested amount')
  }

  if (options.slippageTarget === 'sellAmount') {
    const maxSellAmount = options.maxSellAmount
    if (maxSellAmount !== undefined && maxSellAmount < rawOrderSellAmount) {
      throw new Error('CoW order sell amount is below quoted sell amount')
    }
  }
}
