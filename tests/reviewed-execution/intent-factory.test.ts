import { getAddress, isAddress, zeroAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import { createOperationIntent } from '~/features/reviewed-execution/domain/factory'
import { collectPlanningRequirements } from '~/features/reviewed-execution/planning/requirements'
import { TEST_ACCOUNT, TEST_TOKEN, TEST_VAULT } from './fixtures'
import { makeSwapQuote } from './swap-quote.test-fixture'

describe('operation intent factory', () => {
  it('normalizes every wallet account without leaking Array.map indexes into viem', () => {
    const owner = getAddress('0xabcdefabcdefabcdefabcdefabcdefabcdefabcd')
    const subAccount = getAddress('0x1234567890abcdef1234567890abcdef12345678')
    const intent = createOperationIntent({
      kind: 'deposit',
      planner: 'deposit',
      args: { vaultAddress: TEST_VAULT, assetAddress: TEST_TOKEN, amount: 12n },
      chainId: 1,
      account: owner,
      subAccounts: [owner, subAccount],
      source: 'test',
      createdAt: 1,
      intentId: 'intent-multiple-accounts',
    })

    expect(intent.subAccounts).toEqual([owner, subAccount])
    expect(intent.subAccounts.every(account => isAddress(account))).toBe(true)
  })

  it('strips runtime account state and seals a direct planner constraint', () => {
    const intent = createOperationIntent({
      kind: 'deposit',
      planner: 'deposit',
      args: { vaultAddress: TEST_VAULT, assetAddress: TEST_TOKEN, amount: 12n, account: { mutable: true } },
      chainId: 1,
      account: TEST_ACCOUNT,
      source: 'test',
      createdAt: 1,
      intentId: 'intent-factory',
    })
    expect(intent.planner.args).toEqual({ vaultAddress: TEST_VAULT, assetAddress: TEST_TOKEN, amount: 12n })
    expect(intent.constraints).toEqual([{ kind: 'exact-input', token: TEST_TOKEN, amount: 12n }])
    expect(Object.isFrozen(intent)).toBe(true)
  })

  it('normalizes quotes and derives exact minimum-output and deadline bounds', () => {
    const quote = makeSwapQuote()
    const intent = createOperationIntent({
      kind: 'swap',
      planner: 'swap-from-wallet',
      args: { swapQuote: quote, amount: 10n, tokenIn: TEST_TOKEN },
      chainId: 1,
      account: TEST_ACCOUNT,
      source: 'test',
      createdAt: 1,
      intentId: 'intent-swap',
    })
    expect(intent.constraints).toContainEqual({ kind: 'minimum-output', token: quote.tokenOut.address, amount: BigInt(quote.amountOutMin) })
    expect(intent.constraints).toContainEqual({ kind: 'deadline', timestamp: quote.verify.deadline })
  })

  it('binds borrow limits and planning assets to the underlying token, not the vault', () => {
    const intent = createOperationIntent({
      kind: 'borrow',
      planner: 'borrow',
      args: { vaultAddress: TEST_VAULT, assetAddress: TEST_TOKEN, amount: 12n, borrowAccount: TEST_ACCOUNT },
      chainId: 1,
      account: TEST_ACCOUNT,
      source: 'test',
      createdAt: 1,
      intentId: 'intent-borrow',
    })

    expect(intent.constraints).toEqual([{ kind: 'maximum-input', token: TEST_TOKEN, amount: 12n }])
    const requirements = collectPlanningRequirements([intent])
    expect(requirements.assets).toEqual([TEST_TOKEN])
    expect(requirements.vaults).toEqual([TEST_VAULT])
  })

  it('does not load zero-address swap sentinels as accounts, vaults, or contracts', () => {
    const quote = {
      ...makeSwapQuote(),
      accountIn: zeroAddress,
      vaultIn: zeroAddress,
    }
    const intent = createOperationIntent({
      kind: 'deposit',
      planner: 'deposit-with-swap',
      args: { swapQuote: quote, amount: 10n, tokenIn: TEST_TOKEN },
      chainId: 1,
      account: TEST_ACCOUNT,
      source: 'test',
      createdAt: 1,
      intentId: 'intent-zero-sentinels',
    })

    const requirements = collectPlanningRequirements([intent])
    expect([
      ...requirements.accounts,
      ...requirements.vaults,
      ...requirements.assets,
      ...requirements.contracts,
    ]).not.toContain(zeroAddress)
  })
})
