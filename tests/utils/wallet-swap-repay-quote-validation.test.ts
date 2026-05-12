import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { SwapperMode, SwapVerificationType, type SwapApiQuote } from '~/entities/swap'
import {
  buildSwapVerifierData,
  getSwapRepayVerifierAmount,
  validateWalletSwapRepayQuote,
  type WalletSwapRepayQuoteValidationContext,
} from '~/composables/useEulerOperations/swaps/verify'

const TOKEN_IN = '0x0000000000000000000000000000000000000011' as Address
const TOKEN_OUT = '0x0000000000000000000000000000000000000022' as Address
const BORROW_VAULT = '0x0000000000000000000000000000000000000033' as Address
const ACCOUNT = '0x0000000000000000000000000000000000000044' as Address
const SWAPPER = '0x0000000000000000000000000000000000000055' as Address
const VERIFIER = '0x0000000000000000000000000000000000000066' as Address
const ZERO = '0x0000000000000000000000000000000000000000' as Address

const makeContext = (): WalletSwapRepayQuoteValidationContext => ({
  expectedAccountOut: ACCOUNT,
  expectedReceiver: BORROW_VAULT,
  expectedSwapperAddress: SWAPPER,
  expectedTokenIn: TOKEN_IN,
  expectedTokenOut: TOKEN_OUT,
  expectedVerifierAddress: VERIFIER,
  expectedInputAmount: 1000n,
  requestedSlippage: 10,
  swapperMode: SwapperMode.EXACT_IN,
  targetDebt: 0n,
  currentDebt: 1000n,
  nowTimestamp: 1_700_000_000,
})

const makeQuote = (
  overrides: Partial<SwapApiQuote> = {},
  context = makeContext(),
): SwapApiQuote => {
  const base = {
    amountIn: '1000',
    amountInMax: '1000',
    amountOut: '1000',
    amountOutMin: '900',
    accountIn: ZERO,
    accountOut: context.expectedAccountOut,
    vaultIn: ZERO,
    receiver: context.expectedReceiver,
    tokenIn: {
      address: context.expectedTokenIn,
      chainId: 1,
      decimals: 18,
      logoURI: '',
      name: 'Input',
      symbol: 'IN',
    },
    tokenOut: {
      address: context.expectedTokenOut,
      chainId: 1,
      decimals: 18,
      logoURI: '',
      name: 'Output',
      symbol: 'OUT',
    },
    slippage: context.requestedSlippage,
    swap: {
      swapperAddress: context.expectedSwapperAddress!,
      swapperData: '0x',
      multicallItems: [],
    },
    verify: {
      verifierAddress: context.expectedVerifierAddress!,
      verifierData: '0x',
      type: SwapVerificationType.DebtMax,
      vault: context.expectedReceiver,
      account: context.expectedAccountOut,
      amount: '0',
      deadline: 1_700_001_800,
    },
    route: [{ providerName: 'test-provider' }],
    ...overrides,
  } as SwapApiQuote

  const verifierAmount = getSwapRepayVerifierAmount({
    quote: base,
    swapperMode: context.swapperMode,
    targetDebt: context.targetDebt,
    currentDebt: context.currentDebt,
  })
  const quote = {
    ...base,
    verify: {
      ...base.verify,
      amount: verifierAmount.toString(),
    },
  }

  return {
    ...quote,
    verify: {
      ...quote.verify,
      verifierData: buildSwapVerifierData({
        quote,
        swapperMode: context.swapperMode,
        isRepay: true,
        requestedSlippage: context.requestedSlippage,
        targetDebt: context.targetDebt,
        currentDebt: context.currentDebt,
      }),
    },
  }
}

describe('validateWalletSwapRepayQuote', () => {
  it('accepts a quote bound to the expected wallet repay context', () => {
    expect(() => validateWalletSwapRepayQuote(makeQuote(), makeContext())).not.toThrow()
  })

  it('rejects a quote whose verifier payload was tampered after signing the quote fields', () => {
    const quote = makeQuote()
    quote.verify.verifierData = '0x1234'

    expect(() => validateWalletSwapRepayQuote(quote, makeContext())).toThrow('SwapVerifier data mismatch')
  })

  it('rejects an exact-in quote whose input amount does not match the user request', () => {
    expect(() =>
      validateWalletSwapRepayQuote(makeQuote({ amountIn: '1001' }), makeContext()),
    ).toThrow('amountIn mismatch')
  })

  it('accepts a target-debt quote whose verifier amount matches the target debt', () => {
    const context = {
      ...makeContext(),
      expectedInputAmount: undefined,
      swapperMode: SwapperMode.TARGET_DEBT,
      targetDebt: 250n,
      currentDebt: 1000n,
    }

    expect(() => validateWalletSwapRepayQuote(makeQuote({}, context), context)).not.toThrow()
  })

  it.each([
    ['tokenIn', { tokenIn: { ...makeQuote().tokenIn, address: TOKEN_OUT } }],
    ['tokenOut', { tokenOut: { ...makeQuote().tokenOut, address: TOKEN_IN } }],
    ['receiver', { receiver: TOKEN_IN }],
    ['accountOut', { accountOut: TOKEN_IN }],
    ['verify.vault', { verify: { ...makeQuote().verify, vault: TOKEN_IN } }],
  ])('rejects a quote with mismatched %s', (_field, overrides) => {
    expect(() => validateWalletSwapRepayQuote(makeQuote(overrides as Partial<SwapApiQuote>), makeContext())).toThrow('mismatch')
  })

  it('rejects a quote with a mismatched verifier address', () => {
    expect(() =>
      validateWalletSwapRepayQuote(
        makeQuote({ verify: { ...makeQuote().verify, verifierAddress: TOKEN_IN } }),
        makeContext(),
      ),
    ).toThrow('Unknown swap verifier address')
  })

  it('rejects a quote with a mismatched swapper', () => {
    expect(() =>
      validateWalletSwapRepayQuote(
        makeQuote({ swap: { ...makeQuote().swap, swapperAddress: TOKEN_IN } }),
        makeContext(),
      ),
    ).toThrow('swap.swapperAddress mismatch')
  })

  it('rejects stale or malformed verifier deadlines', () => {
    expect(() =>
      validateWalletSwapRepayQuote(makeQuote({ verify: { ...makeQuote().verify, deadline: 1_600_000_000 } }), makeContext()),
    ).toThrow('verify.deadline expired')

    expect(() =>
      validateWalletSwapRepayQuote(makeQuote({ verify: { ...makeQuote().verify, deadline: 1_700_010_000 } }), makeContext()),
    ).toThrow('verify.deadline too far in the future')

    const malformedDeadlineQuote = makeQuote()
    malformedDeadlineQuote.verify.deadline = Number.NaN
    expect(() =>
      validateWalletSwapRepayQuote(malformedDeadlineQuote, makeContext()),
    ).toThrow('invalid verify.deadline')
  })

  it('rejects malformed and zero verifier amounts', () => {
    const malformedAmountQuote = makeQuote()
    malformedAmountQuote.verify.amount = 'not-a-number'
    expect(() =>
      validateWalletSwapRepayQuote(malformedAmountQuote, makeContext()),
    ).toThrow('invalid verify.amount')

    const zeroAmountQuote = makeQuote()
    zeroAmountQuote.verify.amount = '0'
    expect(() =>
      validateWalletSwapRepayQuote(zeroAmountQuote, makeContext()),
    ).toThrow('verify.amount must be greater than zero')
  })
})
