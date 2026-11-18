import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { createOperationIntent } from '~/features/reviewed-execution/domain/factory'
import { validateIntentSet } from '~/features/reviewed-execution/domain/validators'
import { TEST_ACCOUNT, TEST_TOKEN } from './fixtures'
import { makeSwapQuote } from './swap-quote.test-fixture'

const OTHER = getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd')
const supplyIntent = (recipient = TEST_ACCOUNT, verifier = recipient, source = 'lend') => {
  const quote = makeSwapQuote()
  return createOperationIntent({
    kind: 'deposit',
    planner: 'deposit-with-swap',
    args: {
      amount: 10n,
      tokenIn: TEST_TOKEN,
      swapQuote: { ...quote, accountOut: recipient, verify: { ...quote.verify, account: verifier } },
    },
    account: TEST_ACCOUNT,
    chainId: 1,
    source,
  })
}

describe('Lend swap recipient validation', () => {
  it('rejects a retained spy quote in a connected-wallet supply intent', () => {
    expect(() => validateIntentSet([supplyIntent(OTHER)])).toThrow(/Lend swap quote recipient/)
  })

  it('rejects a mismatched verifier account even if accountOut matches', () => {
    expect(() => validateIntentSet([supplyIntent(TEST_ACCOUNT, OTHER)])).toThrow(/Lend swap quote recipient/)
  })

  it('accepts a supply to the intended account', () => {
    expect(() => validateIntentSet([supplyIntent()])).not.toThrow()
  })

  it('preserves position supplies to explicitly selected subaccounts', () => {
    expect(() => validateIntentSet([supplyIntent(OTHER, OTHER, 'position/supply:review')])).not.toThrow()
  })
})
