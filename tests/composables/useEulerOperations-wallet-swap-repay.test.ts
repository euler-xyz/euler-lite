import type { Abi, Address, Hex } from 'viem'
import { decodeFunctionData } from 'viem'
import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { evcDisableCollateralAbi, evcDisableControllerAbi } from '~/abis/evc'
import { vaultTransferFromMaxAbi } from '~/abis/vault'
import { swapperAbi, swapVerifierAbi, transferFromSenderAbi } from '~/entities/euler/abis'
import { type SwapApiQuote, SwapperMode, SwapVerificationType } from '~/entities/swap'
import type { SecuritizeVault, Vault } from '~/entities/vault'
import type { TxPlan } from '~/entities/txPlan'
import { createSupplyBorrowSwapBuilders } from '~/composables/useEulerOperations/swaps/supply-borrow'
import { buildSwapVerifierData } from '~/composables/useEulerOperations/swaps/verify'
import type { OperationHelpers, OperationsContext } from '~/composables/useEulerOperations/types'
import type { EVCCall } from '~/utils/evc-converter'

const USER = '0x0000000000000000000000000000000000000001' as Address
const SUB_ACCOUNT = '0x0000000000000000000000000000000000000002' as Address
const EVC = '0x0000000000000000000000000000000000000003' as Address
const SWAP_VERIFIER = '0x0000000000000000000000000000000000000004' as Address
const SWAPPER = '0x0000000000000000000000000000000000000005' as Address
const INPUT_TOKEN = '0x0000000000000000000000000000000000000006' as Address
const BORROW_VAULT = '0x0000000000000000000000000000000000000007' as Address
const EVK_COLLATERAL = '0x0000000000000000000000000000000000000008' as Address
const SECURITIZE_COLLATERAL = '0x0000000000000000000000000000000000000009' as Address

const decodeAbi = [
  ...transferFromSenderAbi,
  ...swapperAbi,
  ...swapVerifierAbi,
  ...evcDisableControllerAbi,
  ...evcDisableCollateralAbi,
  ...vaultTransferFromMaxAbi,
] as Abi

const makeVault = (address: Address): Vault => ({
  address,
} as unknown as Vault)

const makeSecuritizeVault = (address: Address): SecuritizeVault => ({
  address,
  type: 'securitize',
} as unknown as SecuritizeVault)

const createContext = (): OperationsContext => ({
  address: ref(USER),
  chainId: ref(1),
  writeContractAsync: vi.fn(),
  signTypedDataAsync: vi.fn(),
  config: {} as OperationsContext['config'],
  eulerCoreAddresses: computed(() => ({ evc: EVC })),
  eulerPeripheryAddresses: computed(() => ({
    swapVerifier: SWAP_VERIFIER,
    swapper: SWAPPER,
  })),
  eulerLensAddresses: computed(() => ({})),
  rpcUrl: '',
  PYTH_HERMES_URL: '',
  SUBGRAPH_URL: '',
  registryGet: vi.fn(),
  registryGetVault: vi.fn((addr: Address) => {
    if (addr.toLowerCase() === EVK_COLLATERAL.toLowerCase()) return makeVault(addr)
    if (addr.toLowerCase() === SECURITIZE_COLLATERAL.toLowerCase()) return makeSecuritizeVault(addr)
    return undefined
  }),
  permit2Enabled: ref(false),
  rpcProvider: {} as OperationsContext['rpcProvider'],
})

const helpers: OperationHelpers = {
  prepareTokenApproval: vi.fn(async () => ({ steps: [], permitCall: undefined, usesPermit2: false })),
  injectPythHealthCheckUpdates: vi.fn(async () => undefined),
  buildEvcBatchStep: ({ evcCalls, label }) => ({
    type: 'evc-batch',
    label,
    to: EVC,
    abi: [],
    functionName: 'batch',
    args: [evcCalls],
  }),
  buildNativeWrapCalls: vi.fn(() => []),
  resolveEffectiveCollaterals: vi.fn(),
  adjustForInterest: (amount: bigint) => amount,
  preparePythUpdates: vi.fn(),
  preparePythUpdatesForHealthCheck: vi.fn(),
}

const makeQuote = (): SwapApiQuote => {
  const quote = {
    amountIn: '100',
    amountInMax: '100',
    amountOut: '100',
    amountOutMin: '100',
    accountIn: USER,
    accountOut: SUB_ACCOUNT,
    vaultIn: BORROW_VAULT,
    receiver: BORROW_VAULT,
    tokenIn: {
      address: INPUT_TOKEN,
      chainId: 1,
      decimals: 18,
      logoURI: '',
      name: 'Input',
      symbol: 'IN',
    },
    tokenOut: {
      address: INPUT_TOKEN,
      chainId: 1,
      decimals: 18,
      logoURI: '',
      name: 'Borrow',
      symbol: 'BRW',
    },
    slippage: 0,
    swap: {
      swapperAddress: SWAPPER,
      swapperData: '0x' as Hex,
      multicallItems: [],
    },
    verify: {
      verifierAddress: SWAP_VERIFIER,
      verifierData: '0x' as Hex,
      type: SwapVerificationType.DebtMax,
      vault: BORROW_VAULT,
      account: SUB_ACCOUNT,
      amount: '100',
      deadline: 0,
    },
    route: [{ providerName: 'test' }],
  } as SwapApiQuote

  quote.verify.verifierData = buildSwapVerifierData({
    quote,
    swapperMode: SwapperMode.EXACT_IN,
    isRepay: true,
    requestedSlippage: 0,
    currentDebt: 100n,
  })

  return quote
}

const planCalls = (plan: TxPlan): EVCCall[] => plan.steps[0]?.args[0] as EVCCall[]

const decodedCalls = (plan: TxPlan) => planCalls(plan).map(call => ({
  target: call.targetContract,
  ...decodeFunctionData({ abi: decodeAbi, data: call.data }),
}))

describe('wallet swap full repay cleanup', () => {
  it('sweeps only EVK collaterals while disabling every collateral', async () => {
    const builders = createSupplyBorrowSwapBuilders(createContext(), helpers)

    const plan = await builders.buildSwapAndRepayPlan({
      inputTokenAddress: INPUT_TOKEN,
      inputAmount: 100n,
      quote: makeQuote(),
      requestedSlippage: 0,
      borrowVaultAddress: BORROW_VAULT,
      subAccount: SUB_ACCOUNT,
      enabledCollaterals: [EVK_COLLATERAL, SECURITIZE_COLLATERAL],
      isFullRepay: true,
      swapperMode: SwapperMode.EXACT_IN,
      currentDebt: 100n,
    })

    const calls = decodedCalls(plan)
    const transferFromMaxCalls = calls.filter(call => call.functionName === 'transferFromMax')
    const disableCollateralCalls = calls.filter(call => call.functionName === 'disableCollateral')

    expect(transferFromMaxCalls).toEqual([
      expect.objectContaining({
        target: EVK_COLLATERAL,
        args: [SUB_ACCOUNT, USER],
      }),
    ])
    expect(disableCollateralCalls).toEqual([
      expect.objectContaining({ args: [SUB_ACCOUNT, EVK_COLLATERAL] }),
      expect.objectContaining({ args: [SUB_ACCOUNT, SECURITIZE_COLLATERAL] }),
    ])
  })
})
