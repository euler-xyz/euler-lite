import type { PlanSwapCollateralWithCoWArgs } from '@eulerxyz/euler-v2-sdk'
import { getEulerSdkFresh } from '~/composables/useEulerSdk'
import { getCowSwapChainConfig } from '~/entities/cowswap'
import { useCowSwapExecutionCore } from './useCowSwapExecutionCore'
import type { OperationPolicyCheck } from '~/utils/operationGuardRegistry'

export type CowSwapCollateralSwapExecuteParams = PlanSwapCollateralWithCoWArgs & {
  chainId: number
}

export const useCowSwapCollateralSwapExecution = () => {
  const core = useCowSwapExecutionCore()

  const executeAsync = async (params: CowSwapCollateralSwapExecuteParams, policyChecks: OperationPolicyCheck[] = []) => {
    const sdk = await getEulerSdkFresh()
    const plan = sdk.executionService.planSwapCollateralWithCoW(params)
    const chainConfig = getCowSwapChainConfig(params.chainId)
    if (!chainConfig) throw new Error(`CowSwap not supported on chain ${params.chainId}`)

    return core.executePlan({
      plan,
      account: params.account.owner,
      chainId: params.chainId,
      cancellationMode: 'cow-api',
      orderbookUrl: chainConfig.orderbookUrl,
      settlementContract: chainConfig.settlementContract,
    }, policyChecks)
  }

  return {
    executeAsync,
    cancelOrder: core.cancelOrder,
    reset: core.reset,
    status: core.status,
    orderUid: core.orderUid,
    isPending: core.isPending,
    explorerUrl: core.explorerUrl,
    error: core.error,
    locallyCancelled: core.locallyCancelled,
    cancellationStatus: core.cancellationStatus,
    cancellationMode: core.cancelMode,
  }
}
