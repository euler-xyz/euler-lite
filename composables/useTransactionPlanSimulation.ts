import type { TransactionPlan, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { formatSimulationFailure, getTxErrorMessage } from '~/utils/tx-errors'

export const useTransactionPlanSimulation = () => {
  const { simulatePlan, simulatePreparedPlan } = useEulerTx()
  const simulationError = ref('')
  const isSimulating = ref(false)

  const clearSimulationError = () => {
    simulationError.value = ''
  }

  const handleResult = (result: Awaited<ReturnType<typeof simulatePlan>>) => {
    if (!result.canExecute) {
      simulationError.value = formatSimulationFailure(result)
      return false
    }
    return true
  }

  const runSimulation = async (plan: TransactionPlan) => {
    clearSimulationError()
    isSimulating.value = true
    try {
      return handleResult(await simulatePlan(plan))
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

  const runPreparedSimulation = async (prepared: TransactionPlanPrepared) => {
    clearSimulationError()
    isSimulating.value = true
    try {
      return handleResult(await simulatePreparedPlan(prepared))
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
