import { useConfig, useSignTypedData, useWriteContract } from '@wagmi/vue'
import type { Address } from 'viem'
import type { OperationsContext } from './types'
import { createPermit2Helpers } from './permit2'
import { createAllowanceHelpers } from './allowance'
import { createOperationHelpers } from './helpers'
import { createExecutionHelpers } from './execution'
import { createVaultBuilders } from './vault'
import { createRepayBuilders } from './repay'
import { createSwapBuilders } from './swaps'
import { useVaultRegistry } from '~/composables/useVaultRegistry'

export const useEulerOperations = () => {
  const { address: walletAddress, chainId } = useWagmi()
  const { isSpyMode, spyAddress } = useSpyMode()
  const { writeContractAsync } = useWriteContract()
  const { signTypedDataAsync } = useSignTypedData()
  const config = useConfig()
  const { eulerCoreAddresses, eulerPeripheryAddresses, eulerLensAddresses } = useEulerAddresses()
  const { PYTH_HERMES_URL, SUBGRAPH_URL } = useEulerConfig()
  const { rpcUrl, client: rpcClient } = useRpcClient()
  const { get: registryGet, getVault: registryGetVault } = useVaultRegistry()
  const { permit2Enabled } = usePermit2Preference()

  // In spy mode, builders use the spy address as the on-behalf-of account so the
  // review modal can render real steps. Actual transaction execution is still
  // blocked in executeTxPlan.
  const address = computed(() => (isSpyMode.value ? (spyAddress.value as Address | undefined) : walletAddress.value))

  const ctx: OperationsContext = {
    address,
    chainId,
    writeContractAsync,
    signTypedDataAsync,
    config,
    eulerCoreAddresses,
    eulerPeripheryAddresses,
    eulerLensAddresses,
    rpcUrl: rpcUrl.value,
    PYTH_HERMES_URL,
    SUBGRAPH_URL,
    registryGet,
    registryGetVault,
    permit2Enabled,
    rpcProvider: rpcClient.value!,
  }

  const permit2 = createPermit2Helpers(ctx)
  const allowance = createAllowanceHelpers(ctx, permit2)
  const helpers = createOperationHelpers(ctx, permit2, allowance)
  const execution = createExecutionHelpers(ctx, allowance)

  const vault = createVaultBuilders(ctx, helpers, permit2, allowance)
  const repay = createRepayBuilders(ctx, helpers)
  const swaps = createSwapBuilders(ctx, helpers)

  return {
    ...execution,
    buildSimulationStateOverride: allowance.buildSimulationStateOverride,
    ...vault,
    ...repay,
    ...swaps,
  }
}
