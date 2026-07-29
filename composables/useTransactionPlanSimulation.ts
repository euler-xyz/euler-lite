import type { SimulationStateOverrideOptions, TransactionPlan, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import {
  formatSimulationFailure,
  getTxErrorMessage,
  isNonBlockingApprovalSimulationError,
  isNonBlockingApprovalSimulationFailure,
} from '~/utils/tx-errors'
import { reportClientEvent } from '~/utils/client-observability'

export const useTransactionPlanSimulation = () => {
  const { simulatePlan, simulatePreparedPlan } = useEulerTx()
  const { chainId } = useEulerAddresses()
  const simulationError = ref('')
  const isSimulating = ref(false)

  const clearSimulationError = () => {
    simulationError.value = ''
  }

  const handleResult = (
    plan: TransactionPlan | TransactionPlanPrepared,
    result: Awaited<ReturnType<typeof simulatePlan>>,
  ) => {
    if (result.snapshotReadFailures?.length) {
      simulationError.value = formatSimulationFailure(result)
      return false
    }

    // canExecute is false when EITHER the simulated batch reverted OR the
    // user is just missing approvals/balances (diagnostics). We only want to
    // block Review on real reverts — the modal handles approval prompts and
    // shows insufficient-balance toasts, and simulations run with state
    // overrides so the batch itself is verified independently.
    const hasHardFailure
      = !!result.failedBatchItems?.length
        || !!result.accountStatusErrors?.length
        || !!result.vaultStatusErrors?.length
        || !!result.simulationError
    if (hasHardFailure) {
      if (isNonBlockingApprovalSimulationFailure(plan, result)) return true
      simulationError.value = formatSimulationFailure(result)
      return false
    }
    return true
  }

  const runSimulation = async (plan: TransactionPlan, stateOverrideOptions?: SimulationStateOverrideOptions) => {
    clearSimulationError()
    isSimulating.value = true
    try {
      return handleResult(plan, await simulatePlan(plan, stateOverrideOptions))
    }
    catch (e) {
      if (await isNonBlockingApprovalSimulationError(plan, e)) return true
      // Transport / wagmi / SDK-side errors (RPC down, signTypedData rejected, etc.)
      void reportClientEvent({
        event: 'tx_plan_prepare_failed',
        flow: 'transaction',
        phase: 'simulate',
        chainId: chainId.value,
      }, e)
      simulationError.value = await getTxErrorMessage(e)
      return false
    }
    finally {
      isSimulating.value = false
    }
  }

  const runPreparedSimulation = async (prepared: TransactionPlanPrepared, stateOverrideOptions?: SimulationStateOverrideOptions) => {
    clearSimulationError()
    isSimulating.value = true
    try {
      return handleResult(prepared, await simulatePreparedPlan(prepared, stateOverrideOptions))
    }
    catch (e) {
      if (await isNonBlockingApprovalSimulationError(prepared, e)) return true
      void reportClientEvent({
        event: 'tx_plan_prepare_failed',
        flow: 'transaction',
        phase: 'simulate_prepared',
        chainId: chainId.value,
      }, e)
      simulationError.value = await getTxErrorMessage(e)
      return false
    }
    finally {
      isSimulating.value = false
    }
  }

  return {
    simulationError,
    isSimulating,
    runSimulation,
    runPreparedSimulation,
    clearSimulationError,
  }
}
