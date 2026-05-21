import type { Address, StateOverride } from 'viem'
import type { OperationsContext, AllowanceHelpers } from './types'
import type { TxPlan } from '~/entities/txPlan'
import { catchToFallback } from '~/utils/errorHandling'
import { applyOperationGuards } from '~/utils/operationGuardRegistry'

export const createGasEstimationHelpers = (
  ctx: OperationsContext,
  allowanceHelpers: AllowanceHelpers,
) => {
  const estimateTxPlanGas = async (plan: TxPlan, owner: Address): Promise<bigint> => {
    const guardedPlan = applyOperationGuards(plan)
    const stepsToEstimate = guardedPlan.steps
      .filter(step => step.type !== 'approve' && step.type !== 'permit2-approve')

    const stateOverride = await catchToFallback(
      async () => {
        const overrides = await allowanceHelpers.buildSimulationStateOverride(guardedPlan, owner)
        return overrides.length ? overrides as StateOverride : undefined
      },
      undefined,
      'estimateTxPlanGas/stateOverrides',
    )

    let total = 0n
    for (const step of stepsToEstimate) {
      /* eslint-disable @typescript-eslint/no-explicit-any -- viem estimateContractGas requires ABI-specific generics */
      total += await ctx.rpcProvider.estimateContractGas({
        account: owner,
        address: step.to,
        abi: step.abi,
        functionName: step.functionName as any,
        args: step.args as any,
        value: step.value ?? 0n,
        stateOverride,
      })
      /* eslint-enable @typescript-eslint/no-explicit-any */
    }
    return total
  }

  return { estimateTxPlanGas }
}
