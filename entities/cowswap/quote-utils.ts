import type { SwapQuote } from '@eulerxyz/euler-v2-sdk'

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
  quote?: Pick<SwapQuote, 'providerData'> | null,
  options: CowSwapQuoteOrderAmountOptions = {},
): CowSwapQuoteOrderAmounts | undefined => {
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
