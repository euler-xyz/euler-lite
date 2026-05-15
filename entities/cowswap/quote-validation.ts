import { getAddress, type Address } from 'viem'
import {
  type SwapApiProviderExtraData,
  type SwapApiQuote,
  SwapVerificationType,
  SwapperMode,
} from '~/entities/swap'
import { COWSWAP_PROVIDER_NAME, isCowQuote } from './constants'

const CLOSE_POSITION_FULL_REPAY_BUY_AMOUNT_BUFFER_DENOMINATOR = 100_000n

export type CowSwapQuoteValidationRequest = {
  chainId?: number
  tokenIn: Address
  tokenOut: Address
  accountIn: Address
  accountOut: Address
  amount: bigint
  vaultIn: Address
  receiver: Address
  origin?: Address
  swapperMode?: SwapperMode
  isRepay?: boolean
  targetDebt?: bigint
  currentDebt?: bigint
  deadline?: number
  providerExtraData?: SwapApiProviderExtraData
}

const parseBigIntAmount = (field: string, value: unknown): bigint => {
  if (typeof value !== 'string' || !/^\d+$/.test(value)) {
    throw new Error(`CoW quote ${field} missing or invalid`)
  }
  return BigInt(value)
}

const assertAddressField = (field: string, actual: string | undefined, expected: string): void => {
  if (!actual) {
    throw new Error(`CoW quote ${field} missing`)
  }
  if (getAddress(actual) !== getAddress(expected)) {
    throw new Error(`CoW quote ${field} mismatch`)
  }
}

const assertBigIntField = (field: string, actual: bigint, expected: bigint): void => {
  if (actual !== expected) {
    throw new Error(`CoW quote ${field} mismatch`)
  }
}

const getExpectedCowSellAmount = (request: CowSwapQuoteValidationRequest): bigint => {
  if (request.providerExtraData?.type === 'collateralSwap') {
    const sharesAmount = request.providerExtraData.swapCollateralSharesAmountIn
    if (sharesAmount === undefined || sharesAmount <= 0n) {
      throw new Error('CoW quote collateral swap sell amount missing')
    }
    return sharesAmount
  }
  return request.amount
}

const getExpectedCowBuyAmount = (request: CowSwapQuoteValidationRequest): bigint => {
  if (
    request.providerExtraData?.type === 'closePosition'
    && request.targetDebt === 0n
    && request.currentDebt !== undefined
  ) {
    return request.currentDebt + request.currentDebt / CLOSE_POSITION_FULL_REPAY_BUY_AMOUNT_BUFFER_DENOMINATOR
  }
  return request.amount
}

const validateSupportedCowRequest = (request: CowSwapQuoteValidationRequest): void => {
  if (
    request.providerExtraData?.type === 'closePosition'
    && request.swapperMode === SwapperMode.TARGET_DEBT
    && request.isRepay
  ) {
    return
  }

  if (
    (request.providerExtraData?.type === 'openPosition' || request.providerExtraData?.type === 'collateralSwap')
    && (request.swapperMode ?? SwapperMode.EXACT_IN) === SwapperMode.EXACT_IN
    && !request.isRepay
  ) {
    return
  }

  throw new Error('Unsupported CoW quote request')
}

export const validateCowSwapQuoteMatchesRequest = (
  request: CowSwapQuoteValidationRequest,
  quote: SwapApiQuote,
): void => {
  validateSupportedCowRequest(request)

  if (!isCowQuote(quote)) {
    throw new Error(`CoW quote route must include ${COWSWAP_PROVIDER_NAME}`)
  }

  assertAddressField('tokenIn.address', quote.tokenIn.address, request.tokenIn)
  assertAddressField('tokenOut.address', quote.tokenOut.address, request.tokenOut)
  assertAddressField('accountIn', quote.accountIn, request.accountIn)
  assertAddressField('accountOut', quote.accountOut, request.accountOut)
  assertAddressField('vaultIn', quote.vaultIn, request.vaultIn)
  assertAddressField('receiver', quote.receiver, request.receiver)
  assertAddressField('verify.vault', quote.verify.vault, request.receiver)
  assertAddressField('verify.account', quote.verify.account, request.accountOut)

  const expectedVerificationType = request.isRepay ? SwapVerificationType.DebtMax : SwapVerificationType.SkimMin
  if (quote.verify.type !== expectedVerificationType) {
    throw new Error('CoW quote verify.type mismatch')
  }
  if (request.deadline !== undefined && quote.verify.deadline !== request.deadline) {
    throw new Error('CoW quote verify.deadline mismatch')
  }

  if (request.chainId !== undefined) {
    if (quote.tokenIn.chainId !== request.chainId) {
      throw new Error('CoW quote tokenIn.chainId mismatch')
    }
    if (quote.tokenOut.chainId !== request.chainId) {
      throw new Error('CoW quote tokenOut.chainId mismatch')
    }
  }

  const quoteId = quote.providerData?.quoteId
  if (typeof quoteId !== 'number' || !Number.isSafeInteger(quoteId) || quoteId < 0) {
    throw new Error('CoW quote quoteId missing or invalid')
  }

  const sellAmount = parseBigIntAmount('providerData.sellAmount', quote.providerData?.sellAmount)
  const feeAmount = parseBigIntAmount('providerData.feeAmount', quote.providerData?.feeAmount)
  const buyAmount = parseBigIntAmount('providerData.buyAmount', quote.providerData?.buyAmount)

  if (sellAmount <= 0n || buyAmount <= 0n) {
    throw new Error('CoW quote order amount must be positive')
  }

  if (request.swapperMode === SwapperMode.TARGET_DEBT) {
    assertBigIntField('providerData.buyAmount', buyAmount, getExpectedCowBuyAmount(request))
    return
  }

  assertBigIntField('providerData.sellAmount + feeAmount', sellAmount + feeAmount, getExpectedCowSellAmount(request))
}
