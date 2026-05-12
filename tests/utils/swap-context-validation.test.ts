import { describe, expect, it } from 'vitest'
import { zeroAddress, type Address } from 'viem'
import { type SwapApiQuote, SwapperMode, SwapVerificationType } from '~/entities/swap'
import { assertSwapQuoteMatchesContext } from '~/utils/swap-validation'

const KNOWN_VERIFIER = '0x0000000000000000000000000000000000000001' as Address
const KNOWN_SWAPPER = '0x0000000000000000000000000000000000000002' as Address
const TOKEN_IN = '0x0000000000000000000000000000000000000003' as Address
const TOKEN_OUT = '0x0000000000000000000000000000000000000004' as Address
const ACCOUNT_OUT = '0x0000000000000000000000000000000000000005' as Address
const RECEIVER = '0x0000000000000000000000000000000000000006' as Address
const OTHER = '0x0000000000000000000000000000000000000007' as Address

const makeQuote = (overrides: Partial<SwapApiQuote> = {}): SwapApiQuote => ({
  amountIn: '1000',
  amountInMax: '1000',
  amountOut: '950',
  amountOutMin: '945',
  accountIn: zeroAddress,
  accountOut: ACCOUNT_OUT,
  vaultIn: zeroAddress,
  receiver: RECEIVER,
  tokenIn: {
    address: TOKEN_IN,
    chainId: 1,
    decimals: 18,
    logoURI: '',
    name: 'Token In',
    symbol: 'TIN',
  },
  tokenOut: {
    address: TOKEN_OUT,
    chainId: 1,
    decimals: 18,
    logoURI: '',
    name: 'Token Out',
    symbol: 'TOUT',
  },
  slippage: 0.5,
  swap: {
    swapperAddress: KNOWN_SWAPPER,
    swapperData: '0x',
    multicallItems: [],
  },
  verify: {
    verifierAddress: KNOWN_VERIFIER,
    verifierData: '0x',
    type: SwapVerificationType.SkimMin,
    vault: RECEIVER,
    account: ACCOUNT_OUT,
    amount: '945',
    deadline: 123,
  },
  route: [{ providerName: 'test' }],
  ...overrides,
}) as SwapApiQuote

const expectedContext = {
  knownSwapVerifier: KNOWN_VERIFIER,
  knownSwapper: KNOWN_SWAPPER,
  verificationType: SwapVerificationType.SkimMin,
  swapperMode: SwapperMode.EXACT_IN,
  isRepay: false,
  tokenIn: TOKEN_IN,
  tokenOut: TOKEN_OUT,
  accountIn: zeroAddress,
  accountOut: ACCOUNT_OUT,
  vaultIn: zeroAddress,
  receiver: RECEIVER,
  verifierVault: RECEIVER,
  verifierAccount: ACCOUNT_OUT,
  amountIn: 1000n,
}

describe('swap quote context validation', () => {
  it('accepts a quote bound to the expected operation context', () => {
    expect(() => assertSwapQuoteMatchesContext(makeQuote(), expectedContext)).not.toThrow()
  })

  it('rejects quote-controlled swapper changes', () => {
    expect(() =>
      assertSwapQuoteMatchesContext(makeQuote({
        swap: {
          swapperAddress: OTHER,
          swapperData: '0x',
          multicallItems: [],
        },
      }), expectedContext),
    ).toThrow('Swap quote swapper address mismatch')
  })

  it('rejects quote-controlled verifier changes', () => {
    expect(() =>
      assertSwapQuoteMatchesContext(makeQuote({
        verify: {
          ...makeQuote().verify,
          verifierAddress: OTHER,
        },
      }), expectedContext),
    ).toThrow('Unknown swap verifier address')
  })

  it('rejects verifier payload target mismatches', () => {
    expect(() =>
      assertSwapQuoteMatchesContext(makeQuote({
        verify: {
          ...makeQuote().verify,
          vault: OTHER,
        },
      }), expectedContext),
    ).toThrow('Swap quote verifier vault mismatch')

    expect(() =>
      assertSwapQuoteMatchesContext(makeQuote({
        verify: {
          ...makeQuote().verify,
          account: OTHER,
        },
      }), expectedContext),
    ).toThrow('Swap quote verifier account mismatch')
  })

  it('rejects account, receiver, token, and amount mismatches', () => {
    expect(() => assertSwapQuoteMatchesContext(makeQuote({ accountOut: OTHER }), expectedContext))
      .toThrow('Swap quote accountOut mismatch')

    expect(() => assertSwapQuoteMatchesContext(makeQuote({ receiver: OTHER }), expectedContext))
      .toThrow('Swap quote receiver mismatch')

    expect(() =>
      assertSwapQuoteMatchesContext(makeQuote({
        tokenOut: {
          ...makeQuote().tokenOut,
          address: OTHER,
        },
      }), expectedContext),
    ).toThrow('Swap quote tokenOut mismatch')

    expect(() => assertSwapQuoteMatchesContext(makeQuote({ amountIn: '999' }), expectedContext))
      .toThrow('Swap quote amountIn mismatch')
  })

  it('rejects swap mode and repay context mismatches', () => {
    expect(() =>
      assertSwapQuoteMatchesContext(makeQuote({
        verify: {
          ...makeQuote().verify,
          type: SwapVerificationType.TransferMin,
        },
      }), expectedContext),
    ).toThrow('Swap verifier type mismatch')

    expect(() =>
      assertSwapQuoteMatchesContext(makeQuote({
        verify: {
          ...makeQuote().verify,
          type: SwapVerificationType.DebtMax,
        },
      }), {
        ...expectedContext,
        verificationType: SwapVerificationType.DebtMax,
      }),
    ).toThrow('Swap quote repay mode mismatch')
  })
})
