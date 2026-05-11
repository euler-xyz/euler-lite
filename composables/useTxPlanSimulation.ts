import type { TxPlan } from '~/entities/txPlan'
import { getTxErrorMessage } from '~/utils/tx-errors'

export const useTxPlanSimulation = () => {
  const { simulateTxPlan } = useEulerOperations()
  const simulationError = ref('')
  const isSimulating = ref(false)

  const clearSimulationError = () => {
    simulationError.value = ''
  }

  const runSimulation = async (plan: TxPlan) => {
    clearSimulationError()
    isSimulating.value = true
    try {
      await simulateTxPlan(plan)
      return true
    }
    catch (e) {
      simulationError.value = getTxErrorMessage(e)
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
    clearSimulationError,
  }
}
