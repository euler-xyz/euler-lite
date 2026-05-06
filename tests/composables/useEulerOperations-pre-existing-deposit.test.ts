import type { Abi, Address } from 'viem'
import { decodeFunctionData, maxUint256 } from 'viem'
import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { evcDisableCollateralAbi, evcDisableControllerAbi, evcEnableControllerAbi } from '~/abis/evc'
import { vaultBorrowAbi, vaultRedeemAbi, vaultRepayWithSharesAbi, vaultSkimAbi, vaultTransferFromMaxAbi, vaultWithdrawAbi } from '~/abis/vault'
import type { TxPlan } from '~/entities/txPlan'
import { createRepayBuilders } from '~/composables/useEulerOperations/repay'
import { createSameAssetSwapBuilders } from '~/composables/useEulerOperations/swaps/same-asset'
import type { OperationHelpers, OperationsContext } from '~/composables/useEulerOperations/types'
import type { EVCCall } from '~/utils/evc-converter'

const USER = '0x0000000000000000000000000000000000000001' as Address
const SUB_ACCOUNT = '0x0000000000000000000000000000000000000002' as Address
const SAVINGS_ACCOUNT = '0x0000000000000000000000000000000000000003' as Address
const EVC = '0x0000000000000000000000000000000000000004' as Address
const COLLATERAL_VAULT = '0x0000000000000000000000000000000000000011' as Address
const BORROW_VAULT = '0x0000000000000000000000000000000000000012' as Address
const SAVINGS_VAULT = '0x0000000000000000000000000000000000000013' as Address
const NEW_VAULT = '0x0000000000000000000000000000000000000014' as Address

const decodeAbi = [
  ...vaultBorrowAbi,
  ...vaultWithdrawAbi,
  ...vaultSkimAbi,
  ...vaultRepayWithSharesAbi,
  ...vaultRedeemAbi,
  ...vaultTransferFromMaxAbi,
  ...evcDisableControllerAbi,
  ...evcDisableCollateralAbi,
  ...evcEnableControllerAbi,
] as const satisfies Abi

const createContext = (existingShares: bigint): OperationsContext => ({
  address: ref(USER),
  chainId: ref(1),
  writeContractAsync: vi.fn(),
  signTypedDataAsync: vi.fn(),
  config: {} as OperationsContext['config'],
  eulerCoreAddresses: computed(() => ({ evc: EVC })),
  eulerPeripheryAddresses: computed(() => ({})),
  eulerLensAddresses: computed(() => ({})),
  rpcUrl: '',
  PYTH_HERMES_URL: '',
  SUBGRAPH_URL: '',
  registryGet: vi.fn(),
  registryGetVault: vi.fn(),
  permit2Enabled: ref(false),
  rpcProvider: {
    readContract: vi.fn(async () => existingShares),
  } as unknown as OperationsContext['rpcProvider'],
})

const helpers: OperationHelpers = {
  prepareTokenApproval: vi.fn(),
  injectPythHealthCheckUpdates: vi.fn(async () => undefined),
  buildEvcBatchStep: ({ evcCalls, label }) => ({
    type: 'evc-batch',
    label,
    to: EVC,
    abi: [],
    functionName: 'batch',
    args: [evcCalls],
  }),
  buildNativeWrapCalls: vi.fn(),
  resolveEffectiveCollaterals: vi.fn(),
  adjustForInterest: (amount: bigint) => (amount * 10_001n) / 10_000n,
  preparePythUpdates: vi.fn(),
  preparePythUpdatesForHealthCheck: vi.fn(),
}

const planCalls = (plan: TxPlan): EVCCall[] => plan.steps[0]?.args[0] as EVCCall[]

const decodedCalls = (plan: TxPlan) => planCalls(plan).map(call => ({
  target: call.targetContract,
  ...decodeFunctionData({ abi: decodeAbi, data: call.data }),
}))

describe('full repay pre-existing liability deposit cleanup', () => {
  it('builds same-asset swap calls on the supplied subaccount', async () => {
    const builders = createSameAssetSwapBuilders(createContext(0n), helpers)

    const plan = await builders.buildSameAssetSwapPlan({
      fromVaultAddress: SAVINGS_VAULT,
      toVaultAddress: NEW_VAULT,
      amount: 100n,
      subAccount: SUB_ACCOUNT,
    })

    const calls = decodedCalls(plan)

    expect(calls).toContainEqual(expect.objectContaining({
      target: SAVINGS_VAULT,
      functionName: 'withdraw',
      args: [100n, NEW_VAULT, SUB_ACCOUNT],
    }))
    expect(calls).toContainEqual(expect.objectContaining({
      target: NEW_VAULT,
      functionName: 'skim',
      args: [100n, SUB_ACCOUNT],
    }))
  })

  it('keeps same-asset swap main-account fallback when no subaccount is provided', async () => {
    const builders = createSameAssetSwapBuilders(createContext(0n), helpers)

    const plan = await builders.buildSameAssetSwapPlan({
      fromVaultAddress: SAVINGS_VAULT,
      toVaultAddress: NEW_VAULT,
      amount: 100n,
    })

    const calls = decodedCalls(plan)

    expect(calls).toContainEqual(expect.objectContaining({
      target: SAVINGS_VAULT,
      functionName: 'withdraw',
      args: [100n, NEW_VAULT, USER],
    }))
    expect(calls).toContainEqual(expect.objectContaining({
      target: NEW_VAULT,
      functionName: 'skim',
      args: [100n, USER],
    }))
  })

  it('keeps same-asset full repay borrow-vault shares when they pre-exist', async () => {
    const builders = createSameAssetSwapBuilders(createContext(1n), helpers)

    const plan = await builders.buildSameAssetFullRepayPlan({
      collateralVaultAddress: COLLATERAL_VAULT,
      borrowVaultAddress: BORROW_VAULT,
      amount: 100n,
      subAccount: SUB_ACCOUNT,
    })

    const calls = decodedCalls(plan)

    expect(calls.map(call => call.functionName)).not.toContain('redeem')
    expect(calls.some(call => call.target === COLLATERAL_VAULT && call.functionName === 'skim')).toBe(false)
  })

  it('sweeps same-asset full repay cushion when there is no pre-existing borrow-vault deposit', async () => {
    const builders = createSameAssetSwapBuilders(createContext(0n), helpers)

    const plan = await builders.buildSameAssetFullRepayPlan({
      collateralVaultAddress: COLLATERAL_VAULT,
      borrowVaultAddress: BORROW_VAULT,
      amount: 100n,
      subAccount: SUB_ACCOUNT,
    })

    const calls = decodedCalls(plan)

    expect(calls).toContainEqual(expect.objectContaining({
      target: BORROW_VAULT,
      functionName: 'redeem',
      args: [maxUint256, COLLATERAL_VAULT, SUB_ACCOUNT],
    }))
    expect(calls).toContainEqual(expect.objectContaining({
      target: COLLATERAL_VAULT,
      functionName: 'skim',
      args: [maxUint256, SUB_ACCOUNT],
    }))
  })

  it('keeps savings full repay borrow-vault shares when they pre-exist', async () => {
    const builders = createRepayBuilders(createContext(1n), helpers)

    const plan = await builders.buildSavingsFullRepayPlan({
      savingsVaultAddress: SAVINGS_VAULT,
      borrowVaultAddress: BORROW_VAULT,
      amount: 100n,
      savingsSubAccount: SAVINGS_ACCOUNT,
      borrowSubAccount: SUB_ACCOUNT,
    })

    const calls = decodedCalls(plan)

    expect(calls.map(call => call.functionName)).not.toContain('redeem')
    expect(calls.some(call => call.target === SAVINGS_VAULT && call.functionName === 'skim')).toBe(false)
  })

  it('sweeps debt migration cushion only when the old vault has no pre-existing deposit', async () => {
    const builders = createSameAssetSwapBuilders(createContext(0n), helpers)

    const plan = await builders.buildSameAssetDebtSwapPlan({
      oldVaultAddress: BORROW_VAULT,
      newVaultAddress: NEW_VAULT,
      amount: 100n,
      subAccount: SUB_ACCOUNT,
    })

    const calls = decodedCalls(plan)

    expect(calls).toContainEqual(expect.objectContaining({
      target: BORROW_VAULT,
      functionName: 'redeem',
      args: [maxUint256, NEW_VAULT, SUB_ACCOUNT],
    }))
    expect(calls).toContainEqual(expect.objectContaining({
      target: NEW_VAULT,
      functionName: 'skim',
      args: [maxUint256, SUB_ACCOUNT],
    }))
  })
})
