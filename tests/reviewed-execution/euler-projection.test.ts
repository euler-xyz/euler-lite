import { describe, expect, it } from 'vitest'
import { projectEulerSimulation } from '~/features/reviewed-execution/simulation/euler-projection'

describe('Euler simulation projection', () => {
  it('preserves the existing review rule for wallet prerequisites', () => {
    expect(projectEulerSimulation({
      canExecute: false,
      simulatedAccounts: [],
      simulatedVaults: [],
    }).canExecute).toBe(true)
  })

  it.each([
    { failedBatchItems: [{}] },
    { accountStatusErrors: [{}] },
    { vaultStatusErrors: [{}] },
    { simulationError: new Error('simulation failed') },
    { snapshotReadFailures: [{}] },
  ])('fails closed for hard simulation evidence: %o', (failure) => {
    expect(projectEulerSimulation({
      canExecute: true,
      simulatedAccounts: [],
      simulatedVaults: [],
      ...failure,
    }).canExecute).toBe(false)
  })
})
