import type { SimulationStateOverrideOptions, TransactionPlan, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { formatSimulationFailure, getTxErrorMessage } from '~/utils/tx-errors'

export const useTransactionPlanSimulation = () => {
  const { simulatePlan, simulatePreparedPlan } = useEulerTx()
  const simulationError = ref('')
  const isSimulating = ref(false)

  const clearSimulationError = () => {
    simulationError.value = ''
  }

  const handleResult = (result: Awaited<ReturnType<typeof simulatePlan>>) => {
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
      simulationError.value = formatSimulationFailure(result)
      return false
    }
    return true
  }

  const runSimulation = async (plan: TransactionPlan, stateOverrideOptions?: SimulationStateOverrideOptions) => {
    clearSimulationError()
    isSimulating.value = true
    try {
      return handleResult(await simulatePlan(plan, stateOverrideOptions))
    }
    catch (e) {
      // Transport / wagmi / SDK-side errors (RPC down, signTypedData rejected, etc.)
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
      return handleResult(await simulatePreparedPlan(prepared, stateOverrideOptions))
    }
    catch (e) {
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
