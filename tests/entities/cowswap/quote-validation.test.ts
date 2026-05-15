import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import {
  type CowSwapQuoteValidationRequest,
  validateCowSwapQuoteMatchesRequest,
} from '~/entities/cowswap/quote-validation'
import { type SwapApiQuote, SwapVerificationType, SwapperMode } from '~/entities/swap'

const TOKEN_IN = '0x1111111111111111111111111111111111111111' as Address
const TOKEN_OUT = '0x2222222222222222222222222222222222222222' as Address
const ACCOUNT_IN = '0x3333333333333333333333333333333333333333' as Address
const ACCOUNT_OUT = '0x4444444444444444444444444444444444444444' as Address
const VAULT_IN = '0x5555555555555555555555555555555555555555' as Address
const RECEIVER = '0x6666666666666666666666666666666666666666' as Address
const VERIFIER = '0x7777777777777777777777777777777777777777' as Address
const SWAPPER = '0x8888888888888888888888888888888888888888' as Address

const baseRequest = (overrides: Partial<CowSwapQuoteValidationRequest> = {}): CowSwapQuoteValidationRequest => ({
  chainId: 1,
  tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT,
  accountIn: ACCOUNT_IN,
  accountOut: ACCOUNT_OUT,
  amount: 1_000n,
  vaultIn: VAULT_IN,
  receiver: RECEIVER,
  swapperMode: SwapperMode.EXACT_IN,
  isRepay: false,
  targetDebt: 0n,
  currentDebt: 0n,
  providerExtraData: { type: 'openPosition' },
  ...overrides,
})

const baseQuote = (overrides: Partial<SwapApiQuote> = {}): SwapApiQuote => ({
  amountIn: '1000',
  amountInMax: '1000',
  amountOut: '2000',
  amountOutMin: '1990',
  accountIn: ACCOUNT_IN,
  accountOut: ACCOUNT_OUT,
  vaultIn: VAULT_IN,
  receiver: RECEIVER,
  tokenIn: {
    address: TOKEN_IN,
    chainId: 1,
    decimals: 18,
    logoURI: '',
    name: 'Token In',
    symbol: 'IN',
  },
  tokenOut: {
    address: TOKEN_OUT,
    chainId: 1,
    decimals: 18,
    logoURI: '',
    name: 'Token Out',
    symbol: 'OUT',
  },
  slippage: 0.5,
  swap: {
    swapperAddress: SWAPPER,
    swapperData: '0x',
    multicallItems: [],
  },
  verify: {
    verifierAddress: VERIFIER,
    verifierData: '0x',
    type: SwapVerificationType.SkimMin,
    vault: RECEIVER,
    account: ACCOUNT_OUT,
    amount: '1990',
    deadline: 123,
  },
  route: [{ providerName: 'CoW Swap' }],
  providerData: {
    quoteId: 42,
    sellAmount: '993',
    feeAmount: '7',
    buyAmount: '2000',
  },
  ...overrides,
})

describe('validateCowSwapQuoteMatchesRequest', () => {
  it('accepts an exact-in CoW quote when returned addresses and sell amount including fee match the request', () => {
    expect(() => validateCowSwapQuoteMatchesRequest(baseRequest(), baseQuote())).not.toThrow()
  })

  it('rejects returned address changes', () => {
    expect(() => validateCowSwapQuoteMatchesRequest(
      baseRequest(),
      baseQuote({ receiver: '0x9999999999999999999999999999999999999999' as Address }),
    )).toThrow('receiver mismatch')
  })

  it('rejects exact-in quotes whose signed sell amount exceeds the requested sell amount', () => {
    expect(() => validateCowSwapQuoteMatchesRequest(
      baseRequest(),
      baseQuote({
        providerData: {
          quoteId: 42,
          sellAmount: '1000',
          feeAmount: '7',
          buyAmount: '2000',
        },
      }),
    )).toThrow('providerData.sellAmount + feeAmount mismatch')
  })

  it('uses collateral-swap share amount as the expected exact-in sell amount', () => {
    expect(() => validateCowSwapQuoteMatchesRequest(
      baseRequest({
        amount: 500n,
        providerExtraData: {
          type: 'collateralSwap',
          swapCollateralSharesAmountIn: 1_000n,
        },
      }),
      baseQuote(),
    )).not.toThrow()
  })

  it('accepts full close-position target-debt quotes with the router buy-amount buffer', () => {
    expect(() => validateCowSwapQuoteMatchesRequest(
      baseRequest({
        amount: 2_000n,
        swapperMode: SwapperMode.TARGET_DEBT,
        isRepay: true,
        targetDebt: 0n,
        currentDebt: 2_000_000n,
        providerExtraData: { type: 'closePosition' },
      }),
      baseQuote({
        verify: {
          ...baseQuote().verify,
          type: SwapVerificationType.DebtMax,
          amount: '0',
        },
        providerData: {
          quoteId: 42,
          sellAmount: '5000',
          feeAmount: '25',
          buyAmount: '2000020',
        },
      }),
    )).not.toThrow()
  })

  it('rejects target-debt quotes whose buy amount differs from the requested debt amount', () => {
    expect(() => validateCowSwapQuoteMatchesRequest(
      baseRequest({
        amount: 2_000n,
        swapperMode: SwapperMode.TARGET_DEBT,
        isRepay: true,
        targetDebt: 1_000n,
        currentDebt: 3_000n,
        providerExtraData: { type: 'closePosition' },
      }),
      baseQuote({
        verify: {
          ...baseQuote().verify,
          type: SwapVerificationType.DebtMax,
          amount: '1000',
        },
        providerData: {
          quoteId: 42,
          sellAmount: '5000',
          feeAmount: '25',
          buyAmount: '2001',
        },
      }),
    )).toThrow('providerData.buyAmount mismatch')
  })

  it('requires a CoW quote id before the quote can be signed into an order', () => {
    expect(() => validateCowSwapQuoteMatchesRequest(
      baseRequest(),
      baseQuote({
        providerData: {
          sellAmount: '993',
          feeAmount: '7',
          buyAmount: '2000',
        },
      }),
    )).toThrow('quoteId missing or invalid')
  })
})
