import type { TxPlan } from '~/entities/txPlan'
import { getTxErrorMessage } from '~/utils/tx-errors'

export const useTxPlanSimulation = () => {
  const { simulateTxPlan } = useEulerOperations()
  const { isSpyMode } = useSpyMode()
  const simulationError = ref('')
  const isSimulating = ref(false)

  const clearSimulationError = () => {
    simulationError.value = ''
  }

  const runSimulation = async (plan: TxPlan) => {
    clearSimulationError()
    // Spy mode is preview-only — skip on-chain simulation so the review modal
    // always opens with the real steps even when the spy account's current
    // state would make a real transaction revert.
    if (isSpyMode.value) return true
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
