import { describe, expect, it, vi } from 'vitest'
import { Account, ExecutionService, flattenBatchEntries, type IHasVaultAddress, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { decodeFunctionData, getAddress, maxUint256, parseAbi, type Hash } from 'viem'
import { createOperationIntent } from '~/features/reviewed-execution/domain/factory'
import { assertExpectedIntentPlans, captureIntentPlanExpectation } from '~/features/reviewed-execution/planning/compiler'
import { createLiteIntentCompilerRegistry } from '~/features/reviewed-execution/planning/lite-compilers'
import type { PlanningSnapshot } from '~/features/reviewed-execution/planning/snapshot-loader'
import { buildRefinanceIntentArgs } from '~/utils/refinance-intent'
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
    planSwapCollateral: vi.fn((_args: unknown) => plan),
    planSwapDebt: vi.fn((_args: unknown) => plan),
    planMigrateSameAssetCollateral: vi.fn(() => plan),
    planMigrateSameAssetDebt: vi.fn(() => plan),
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
    kind: planner === 'refinance-position'
      ? 'refinance'
      : planner === 'borrow' || planner === 'swap-and-borrow'
        ? 'borrow'
        : planner === 'deposit'
          ? 'deposit'
          : 'withdraw',
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
  it('rejects a cart recompilation that drops the previewed collateral re-enable', async () => {
    const sourceVault = getAddress('0x5000000000000000000000000000000000000000')
    const evc = getAddress('0x6000000000000000000000000000000000000000')
    const sdk = { executionService: new ExecutionService({
      getDeployment: () => ({ addresses: { coreAddrs: { evc } } }),
    } as never) }
    const accountAtStage = (beforeWithdrawal: boolean) => new Account({
      chainId: 1,
      owner: ACCOUNT,
      subAccounts: {
        [SUB_ACCOUNT]: {
          timestamp: 0, account: SUB_ACCOUNT, owner: ACCOUNT, lastAccountStatusCheckTimestamp: 0,
          enabledControllers: [],
          enabledCollaterals: beforeWithdrawal ? [sourceVault, VAULT] : [sourceVault],
          positions: (beforeWithdrawal ? [sourceVault, VAULT] : [sourceVault]).map(vaultAddress => ({
            account: SUB_ACCOUNT, vaultAddress, asset: TOKEN, shares: 10n, assets: 10n,
            borrowed: 0n, isController: false, isCollateral: true, balanceForwarderEnabled: false,
          })),
        },
      },
    })
    const baseAccount = accountAtStage(true)
    const projectedAccount = accountAtStage(false)
    const quote = {
      ...makeSwapQuote(),
      vaultIn: sourceVault, receiver: VAULT, accountIn: SUB_ACCOUNT, accountOut: SUB_ACCOUNT,
    }
    const withdraw = createOperationIntent({
      kind: 'withdraw', planner: 'redeem',
      args: { vaultAddress: VAULT, shares: maxUint256, owner: SUB_ACCOUNT, disableCollateral: true },
      chainId: 1, account: ACCOUNT, subAccounts: [SUB_ACCOUNT], source: 'test', createdAt: 1,
    })
    const refinance = createOperationIntent({
      kind: 'refinance', planner: 'refinance-position',
      args: buildRefinanceIntentArgs({ collateral: {
        fromVault: sourceVault, toVault: VAULT, amount: 10n, positionAccount: SUB_ACCOUNT,
        fromAsset: quote.tokenIn.address, toAsset: quote.tokenOut.address,
        isMax: true, enableCollateralTo: true, disableCollateralFrom: true, swapQuote: quote, swapperMode: 0,
      } }),
      chainId: 1, account: ACCOUNT, subAccounts: [SUB_ACCOUNT], source: 'test', createdAt: 2,
    })
    const registry = createLiteIntentCompilerRegistry(sdk)
    const compileAgainst = (intents: readonly ReturnType<typeof createOperationIntent>[], account: Account<IHasVaultAddress>) =>
      registry.compile(intents, { snapshot, runtime: { account, sdk } }, () => {})
    const firstPreview = await compileAgainst([withdraw], baseAccount)
    const secondPreview = await compileAgainst([refinance], projectedAccount)
    const expected = [
      captureIntentPlanExpectation(withdraw, firstPreview.plan),
      captureIntentPlanExpectation(refinance, secondPreview.plan),
    ]
    const compiled = await compileAgainst([withdraw, refinance], baseAccount)
    const collateralAbi = parseAbi([
      'function enableCollateral(address account, address vault) payable',
      'function disableCollateral(address account, address vault) payable',
    ])
    const evcCalls = (plan: TransactionPlan) => plan.flatMap(item => item.type === 'evcBatch'
      ? flattenBatchEntries(item.items).filter(call => call.targetContract === evc)
          .map(call => decodeFunctionData({ abi: collateralAbi, data: call.data }))
      : [])

    expect(evcCalls(secondPreview.plan)).toContainEqual({ functionName: 'enableCollateral', args: [SUB_ACCOUNT, VAULT] })
    expect(evcCalls(compiled.plan)).not.toContainEqual({ functionName: 'enableCollateral', args: [SUB_ACCOUNT, VAULT] })
    expect(evcCalls(compiled.plan)).toEqual(expect.arrayContaining([
      { functionName: 'disableCollateral', args: [SUB_ACCOUNT, VAULT] },
      { functionName: 'disableCollateral', args: [SUB_ACCOUNT, sourceVault] },
    ]))
    expect(() => assertExpectedIntentPlans(compiled.intentPlans, expected)).toThrow(/Batch operations changed/)
    expect(() => assertExpectedIntentPlans(secondPreview.intentPlans, [expected[1]])).not.toThrow()
  })

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

  it('passes only swap-debt compiler arguments for a refinance debt swap', async () => {
    const quote = makeSwapQuote()
    const calls = await compile('refinance-position', {
      debt: {
        planner: 'swap-debt',
        args: { swapQuote: quote, swapperMode: 1 },
      },
    })

    const args = calls.planSwapDebt.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(Object.keys(args).sort()).toEqual(['account', 'swapQuote', 'swapperMode'])
    expect(args).toMatchObject({ swapQuote: quote, swapperMode: 1 })
  })

  it('passes only swap-collateral compiler arguments for a refinance collateral swap', async () => {
    const quote = makeSwapQuote()
    const calls = await compile('refinance-position', {
      collateral: {
        planner: 'swap-collateral',
        args: { swapQuote: quote, swapperMode: 0 },
      },
    })

    const args = calls.planSwapCollateral.mock.calls[0]?.[0] as unknown as Record<string, unknown>
    expect(Object.keys(args).sort()).toEqual(['account', 'swapQuote', 'swapperMode'])
    expect(args).toMatchObject({ swapQuote: quote, swapperMode: 0 })
  })
})
