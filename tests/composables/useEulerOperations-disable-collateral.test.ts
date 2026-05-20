import type { Abi, Address } from 'viem'
import { decodeFunctionData } from 'viem'
import { computed, ref } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import { evcDisableCollateralAbi } from '~/abis/evc'
import { vaultTransferFromMaxAbi } from '~/abis/vault'
import type { SecuritizeVault, Vault } from '~/entities/vault'
import type { TxPlan } from '~/entities/txPlan'
import { createRepayBuilders } from '~/composables/useEulerOperations/repay'
import type { OperationHelpers, OperationsContext } from '~/composables/useEulerOperations/types'
import type { EVCCall } from '~/utils/evc-converter'

const USER = '0x0000000000000000000000000000000000000001' as Address
const SUB_ACCOUNT = '0x0000000000000000000000000000000000000002' as Address
const EVC = '0x0000000000000000000000000000000000000003' as Address
const BORROW_VAULT = '0x0000000000000000000000000000000000000004' as Address
const EVK_COLLATERAL = '0x0000000000000000000000000000000000000005' as Address
const SECURITIZE_COLLATERAL = '0x0000000000000000000000000000000000000006' as Address

const decodeAbi = [
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
  eulerPeripheryAddresses: computed(() => ({})),
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
  adjustForInterest: (amount: bigint) => amount,
  preparePythUpdates: vi.fn(),
  preparePythUpdatesForHealthCheck: vi.fn(),
}

const planCalls = (plan: TxPlan): EVCCall[] => plan.steps[0]?.args[0] as EVCCall[]

const decodedCalls = (plan: TxPlan) => planCalls(plan).map(call => ({
  target: call.targetContract,
  ...decodeFunctionData({ abi: decodeAbi, data: call.data }),
}))

describe('disable collateral cleanup', () => {
  it('sweeps EVK collateral from subaccounts before disabling it', async () => {
    const builders = createRepayBuilders(createContext(), helpers)

    const plan = await builders.buildDisableCollateralPlan(
      SUB_ACCOUNT,
      EVK_COLLATERAL,
      BORROW_VAULT,
      [EVK_COLLATERAL],
    )

    expect(decodedCalls(plan)).toEqual([
      expect.objectContaining({
        target: EVK_COLLATERAL,
        functionName: 'transferFromMax',
        args: [SUB_ACCOUNT, USER],
      }),
      expect.objectContaining({
        target: EVC,
        functionName: 'disableCollateral',
        args: [SUB_ACCOUNT, EVK_COLLATERAL],
      }),
    ])
  })

  it('does not sweep Securitize collateral when disabling it from a subaccount', async () => {
    const builders = createRepayBuilders(createContext(), helpers)

    const plan = await builders.buildDisableCollateralPlan(
      SUB_ACCOUNT,
      SECURITIZE_COLLATERAL,
      BORROW_VAULT,
      [SECURITIZE_COLLATERAL],
    )

    expect(decodedCalls(plan)).toEqual([
      expect.objectContaining({
        target: EVC,
        functionName: 'disableCollateral',
        args: [SUB_ACCOUNT, SECURITIZE_COLLATERAL],
      }),
    ])
  })
})
