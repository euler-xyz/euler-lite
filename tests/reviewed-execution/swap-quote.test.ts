import { getAddress } from 'viem'
import { SwapVerificationType, type SwapQuote } from '@eulerxyz/euler-v2-sdk'
import { describe, expect, it } from 'vitest'
import { assertOperationIntent } from '~/features/reviewed-execution/domain/schemas'
import { normalizeIntentSwapQuote, rehydrateIntentSwapQuote } from '~/features/reviewed-execution/domain/swap-quote'
import type { OperationIntent } from '~/features/reviewed-execution/domain/intents'
import { TEST_ACCOUNT, TEST_TOKEN, TEST_VAULT } from './fixtures'

const OUT = getAddress('0x5000000000000000000000000000000000000000')
const quote = (): SwapQuote => ({
  amountIn: '100',
  amountInMax: '101',
  amountOut: '99',
  amountOutMin: '98',
  accountIn: TEST_ACCOUNT,
  accountOut: TEST_ACCOUNT,
  vaultIn: TEST_VAULT,
  receiver: TEST_ACCOUNT,
  tokenIn: { address: TEST_TOKEN, chainId: 1, decimals: 18, logoURI: '', name: 'Input', symbol: 'IN', meta: { ignored: true } },
  tokenOut: { address: OUT, chainId: 1, decimals: 6, logoURI: '', name: 'Output', symbol: 'OUT' },
  slippage: 0.5,
  swap: { swapperAddress: TEST_VAULT, swapperData: '0x1234', multicallItems: [{ functionName: 'swap', args: [1n, TEST_TOKEN], data: '0xabcd' }] },
  verify: { verifierAddress: TEST_VAULT, verifierData: '0x5678', type: SwapVerificationType.SkimMin, vault: TEST_VAULT, account: TEST_ACCOUNT, amount: '98', deadline: 1_800_000_000 },
  route: [{ providerName: 'EulerSwap' }],
  providerData: { quoteId: 7, sellAmount: '100', buyAmount: '99', feeAmount: '1' },
  transferOutputToReceiver: true,
})

const intent = (swapQuote: unknown): OperationIntent => ({
  schemaVersion: 1,
  intentId: 'swap-1',
  revision: 1,
  kind: 'swap',
  chainId: 1,
  account: TEST_ACCOUNT,
  subAccounts: [TEST_ACCOUNT],
  planner: { name: 'swap-from-wallet', args: { swapQuote: swapQuote as never, amount: 100n, tokenIn: TEST_TOKEN } },
  constraints: [
    { kind: 'exact-input', token: TEST_TOKEN, amount: 100n },
    { kind: 'minimum-output', token: OUT, amount: 98n },
    { kind: 'deadline', timestamp: 1_800_000_000 },
  ],
  metadata: { createdAt: 1, source: 'test', operation: 'test' },
})

describe('reviewed execution swap quote DTO', () => {
  it('round-trips the public SDK quote through an integer-only exact schema', () => {
    const normalized = normalizeIntentSwapQuote(quote())
    expect(normalized.slippageBps).toBe(50)
    expect(normalized.tokenIn).not.toHaveProperty('meta')
    expect(rehydrateIntentSwapQuote(normalized)).toMatchObject({ amountOutMin: '98', slippage: 0.5 })
    expect(() => assertOperationIntent(intent(normalized))).not.toThrow()
  })

  it('rejects an unknown nested quote field', () => {
    const normalized = normalizeIntentSwapQuote(quote())
    expect(() => assertOperationIntent(intent({ ...normalized, injectedTarget: TEST_TOKEN }))).toThrow(/injectedTarget is not supported/)
  })

  it('rejects slippage that cannot be sealed exactly as basis points', () => {
    expect(() => normalizeIntentSwapQuote({ ...quote(), slippage: 0.123 } as SwapQuote)).toThrow(/basis points/)
  })
})
