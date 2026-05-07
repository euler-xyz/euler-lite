import type { Address, Hex } from 'viem'
import type { Ref, ComputedRef } from 'vue'
import type { useConfig, useWriteContract, useSignTypedData } from '@wagmi/vue'
import type { getPublicClient } from '~/utils/public-client'

export interface OperationsContext {
  address: Ref<Address | undefined>
  chainId: Ref<number | undefined>
  writeContractAsync: ReturnType<typeof useWriteContract>['writeContractAsync']
  signTypedDataAsync: ReturnType<typeof useSignTypedData>['signTypedDataAsync']
  config: ReturnType<typeof useConfig>

  eulerCoreAddresses: ComputedRef<Record<string, string | undefined> | null>
  eulerPeripheryAddresses: ComputedRef<Record<string, string | undefined> | null>
  eulerLensAddresses: ComputedRef<Record<string, string | undefined> | null>

  rpcUrl: string
  PYTH_HERMES_URL: string
  SUBGRAPH_URL: string

  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- registry returns polymorphic vault types
  registryGet: (addr: string) => any
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- registry returns polymorphic vault types
  registryGetVault: (addr: Address) => any
  permit2Enabled: Ref<boolean>
  rpcProvider: ReturnType<typeof getPublicClient>
}

export interface Permit2Helpers {
  resolvePermit2Address: () => Address | undefined
  getPermit2Allowance: (token: Address, spender: Address, owner: Address, permit2Address?: Address) => Promise<{ amount: bigint, expiration: bigint, nonce: bigint }>
  buildPermit2Call: (token: Address, spender: Address, requiredAmount: bigint, owner: Address, permit2Address?: Address, knownAllowance?: { amount: bigint, expiration: bigint, nonce: bigint }) => Promise<import('~/utils/evc-converter').EVCCall | undefined>
  computePermit2AllowanceSlot: (owner: Address, token: Address, spender: Address) => Hex
  buildPermit2Overrides: (pairsByPermit2: Map<string, { address: Address, pairs: { token: Address, spender: Address }[] }>, owner: Address) => import('viem').StateOverride
}

export interface AllowanceHelpers {
  checkAllowance: (assetAddress: Address, spenderAddress: Address, userAddress: Address) => Promise<bigint>
  normalizeAddress: (address: Address | string) => string
  computeErc20AllowanceSlot: (owner: Address, spender: Address, slotIndex: bigint) => Hex
  resolveAllowanceSlotIndex: (token: Address, owner: Address, spender: Address) => Promise<bigint | undefined>
  buildErc20AllowanceOverrides: (pairs: { token: Address, spender: Address }[], owner: Address) => Promise<import('viem').StateOverride>
  extractTokenFromTransferFromSender: (data: string) => Address | undefined
  buildSimulationStateOverride: (plan: import('~/entities/txPlan').TxPlan, owner: Address) => Promise<import('viem').StateOverride>
}

export interface OperationHelpers {
  prepareTokenApproval: (params: {
    assetAddr: Address
    spenderAddr: Address
    userAddr: Address
    amount: bigint
    includePermit2Call?: boolean
  }) => Promise<{ steps: import('~/entities/txPlan').TxStep[], permitCall: import('~/utils/evc-converter').EVCCall | undefined, usesPermit2: boolean }>

  injectPythHealthCheckUpdates: (params: {
    evcCalls: import('~/utils/evc-converter').EVCCall[]
    liabilityVaultAddr: string
    enabledCollaterals?: string[]
    additionalCollaterals?: string[]
    removingCollaterals?: string[]
    userAddr: Address
  }) => Promise<void>

  buildEvcBatchStep: (params: {
    evcCalls: import('~/utils/evc-converter').EVCCall[]
    label: string
  }) => import('~/entities/txPlan').TxStep

  buildNativeWrapCalls: (params: {
    wrappedTokenAddress: Address
    amount: bigint
    userAddr: Address
  }) => import('~/utils/evc-converter').EVCCall[]

  resolveEffectiveCollaterals: (enabledCollaterals?: string[], adding?: string[], removing?: string[]) => string[]

  adjustForInterest: (amount: bigint) => bigint

  preparePythUpdates: (vaultAddresses: string[], sender: Address) => Promise<{ calls: import('~/utils/evc-converter').EVCCall[], totalFee: bigint }>

  preparePythUpdatesForHealthCheck: (liabilityVaultAddress: string, collateralVaultAddresses: string[], sender: Address) => Promise<{ calls: import('~/utils/evc-converter').EVCCall[], totalFee: bigint }>
}
