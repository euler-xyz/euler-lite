import type { PlanClosePositionWithCowArgs } from '@eulerxyz/euler-v2-sdk'
import { getEulerSdkFresh } from '~/composables/useEulerSdk'
import { useCowSwapExecutionCore } from './useCowSwapExecutionCore'
import type { OperationPolicyCheck } from '~/utils/operationGuardRegistry'

export type CowSwapClosePositionExecuteParams = PlanClosePositionWithCowArgs & {
  chainId: number
}

export const useCowSwapClosePositionExecution = () => {
  const core = useCowSwapExecutionCore()

  const executeAsync = async (params: CowSwapClosePositionExecuteParams, policyChecks: OperationPolicyCheck[] = []) => {
    const sdk = await getEulerSdkFresh()
    const plan = sdk.executionService.planClosePositionWithCow(params)

    return core.executePlan({
      plan,
      account: params.account.owner,
      chainId: params.chainId,
      cancellationMode: 'evc-permit',
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
