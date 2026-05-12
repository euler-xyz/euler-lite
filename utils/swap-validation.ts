import type { Address } from 'viem'
import { type SwapApiQuote, SwapperMode, SwapVerificationType } from '~/entities/swap'
import { normalizeAddress } from '~/utils/normalizeAddress'

export function assertSwapperVerifierAllowed(
  swapVerifierAddress: string,
  knownSwapVerifier: string | undefined,
): void {
  if (!knownSwapVerifier) {
    throw new Error('Known swap verifier address not configured')
  }
  if (swapVerifierAddress.toLowerCase() !== knownSwapVerifier.toLowerCase()) {
    throw new Error(
      `Unknown swap verifier address: ${swapVerifierAddress}. Expected: ${knownSwapVerifier}`,
    )
  }
}

export interface SwapQuoteExpectedContext {
  knownSwapVerifier: string | undefined
  knownSwapper: string | undefined
  verificationType: SwapVerificationType
  swapperMode: SwapperMode
  isRepay: boolean
  tokenIn?: Address
  tokenOut?: Address
  accountIn?: Address
  accountOut?: Address
  vaultIn?: Address
  receiver?: Address
  verifierVault?: Address
  verifierAccount?: Address
  amountIn?: bigint
}

const getTokenAddress = (quote: SwapApiQuote, side: 'tokenIn' | 'tokenOut') =>
  quote[side].address || quote[side].addressInfo

const assertAddressEqual = (
  label: string,
  actual: string | undefined,
  expected: string | undefined,
) => {
  if (!expected) return
  if (!actual) {
    throw new Error(`Swap quote ${label} missing`)
  }
  if (normalizeAddress(actual).toLowerCase() !== normalizeAddress(expected).toLowerCase()) {
    throw new Error(`Swap quote ${label} mismatch`)
  }
}

const assertAmountEqual = (
  label: string,
  actual: string | undefined,
  expected: bigint | undefined,
) => {
  if (expected === undefined) return
  if (actual === undefined || actual === '') {
    throw new Error(`Swap quote ${label} missing`)
  }
  if (BigInt(actual) !== expected) {
    throw new Error(`Swap quote ${label} mismatch`)
  }
}

export function assertSwapQuoteMatchesContext(
  quote: SwapApiQuote,
  expected: SwapQuoteExpectedContext,
): void {
  assertSwapperVerifierAllowed(quote.verify.verifierAddress, expected.knownSwapVerifier)

  if (!expected.knownSwapper) {
    throw new Error('Known swapper address not configured')
  }
  assertAddressEqual('swapper address', quote.swap.swapperAddress, expected.knownSwapper)

  if (quote.verify.type !== expected.verificationType) {
    throw new Error('Swap verifier type mismatch')
  }

  assertAddressEqual('tokenIn', getTokenAddress(quote, 'tokenIn'), expected.tokenIn)
  assertAddressEqual('tokenOut', getTokenAddress(quote, 'tokenOut'), expected.tokenOut)
  assertAddressEqual('accountIn', quote.accountIn, expected.accountIn)
  assertAddressEqual('accountOut', quote.accountOut, expected.accountOut)
  assertAddressEqual('vaultIn', quote.vaultIn, expected.vaultIn)
  assertAddressEqual('receiver', quote.receiver, expected.receiver)
  assertAddressEqual('verifier vault', quote.verify.vault, expected.verifierVault)
  assertAddressEqual('verifier account', quote.verify.account, expected.verifierAccount)

  if (expected.swapperMode === SwapperMode.EXACT_IN) {
    assertAmountEqual('amountIn', quote.amountIn, expected.amountIn)
  }

  if (expected.isRepay && quote.verify.type !== SwapVerificationType.DebtMax) {
    throw new Error('Swap quote repay mode mismatch')
  }
  if (!expected.isRepay && quote.verify.type === SwapVerificationType.DebtMax) {
    throw new Error('Swap quote repay mode mismatch')
  }
}
