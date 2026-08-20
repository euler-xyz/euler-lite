import { describe, expect, it, vi } from 'vitest'
import type { Account, IHasVaultAddress, TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { getAddress, type Hash } from 'viem'
import { createOperationIntent } from '~/features/reviewed-execution/domain/factory'
import { createLiteIntentCompilerRegistry } from '~/features/reviewed-execution/planning/lite-compilers'
import type { PlanningSnapshot } from '~/features/reviewed-execution/planning/snapshot-loader'
import { makeSwapQuote } from './swap-quote.test-fixture'

const ACCOUNT = getAddress('0x1000000000000000000000000000000000000000')
const SUB_ACCOUNT = getAddress('0x2000000000000000000000000000000000000000')
const VAULT = getAddress('0x3000000000000000000000000000000000000000')
const TOKEN = getAddress('0x4000000000000000000000000000000000000000')
const HASH = `0x${'11'.repeat(32)}` as Hash
const plan: TransactionPlan = [{
  type: 'evcBatch',
  items: [{ targetContract: VAULT, onBehalfOfAccount: ACCOUNT, value: 0n, data: '0x12345678' }],
}]
const snapshot: PlanningSnapshot = {
  schemaVersion: 1,
  intentSetHash: HASH,
  owner: ACCOUNT,
  chainId: 1,
  observedBlock: 1n,
  dataSourceVersions: {},
  records: {},
  digest: HASH,
}

const compile = async (planner: Parameters<typeof createOperationIntent>[0]['planner'], args: Record<string, unknown>) => {
  const calls = {
    planDeposit: vi.fn(() => plan),
    planWithdraw: vi.fn(() => plan),
    planRedeem: vi.fn(() => plan),
    planBorrow: vi.fn(() => plan),
    planSwapAndBorrowFromWallet: vi.fn(() => plan),
  }
  const fallback = vi.fn(() => plan)
  const sdk = {
    executionService: new Proxy(calls, {
      get(target, key) {
        if (key === 'mergePlans') return (plans: TransactionPlan[]) => plans.flat()
        return target[key as keyof typeof target] ?? fallback
      },
    }),
  }
  const intent = createOperationIntent({
    kind: planner === 'borrow' || planner === 'swap-and-borrow' ? 'borrow' : planner === 'deposit' ? 'deposit' : 'withdraw',
    planner,
    args,
    chainId: 1,
    account: ACCOUNT,
    source: 'test',
    subAccounts: [SUB_ACCOUNT],
    createdAt: 1,
  })
  const registry = createLiteIntentCompilerRegistry(sdk as never)
  await registry.compile([intent], {
    snapshot,
    runtime: { account: { chainId: 1, owner: ACCOUNT } as Account<IHasVaultAddress>, sdk },
  }, () => {})
  return calls
}

describe('Lite intent compiler wrapper parity', () => {
  it.each([
    ['deposit', { vaultAddress: VAULT, assetAddress: TOKEN, amount: 1n }, 'planDeposit'],
    ['withdraw', { vaultAddress: VAULT, owner: SUB_ACCOUNT, assets: 1n }, 'planWithdraw'],
    ['redeem', { vaultAddress: VAULT, owner: SUB_ACCOUNT, shares: 1n }, 'planRedeem'],
    ['borrow', { vaultAddress: VAULT, assetAddress: TOKEN, amount: 1n, borrowAccount: SUB_ACCOUNT }, 'planBorrow'],
  ] as const)('applies the effective-account receiver default for %s', async (planner, args, method) => {
    const calls = await compile(planner, args)
    expect(calls[method]).toHaveBeenCalledWith(expect.objectContaining({ receiver: ACCOUNT }))
  })

  it('derives the swap-borrow account from the quote when the intent omits it', async () => {
    const quote = { ...makeSwapQuote(), accountOut: SUB_ACCOUNT }
    const calls = await compile('swap-and-borrow', {
      swapQuote: quote,
      amount: 1n,
      tokenIn: TOKEN,
      collateralVault: VAULT,
      borrowVault: VAULT,
      borrowAmount: 1n,
    })
    expect(calls.planSwapAndBorrowFromWallet).toHaveBeenCalledWith(expect.objectContaining({ borrowAccount: SUB_ACCOUNT }))
  })
})
