import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { useTransactionPlanSimulation } from '~/composables/useTransactionPlanSimulation'

const simulatePlan = vi.fn()
const simulatePreparedPlan = vi.fn()

describe('useTransactionPlanSimulation', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('useEulerTx', () => ({
      simulatePlan,
      simulatePreparedPlan,
    }))
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  })

  it('blocks incomplete snapshots even when the revert is approval-like', async () => {
    simulatePlan.mockResolvedValue({
      failedBatchItems: [{
        index: 0,
        error: '0x',
        decodedError: [{
          signature: 'E_TransferFromFailed()',
          params: [],
        }],
      }],
      snapshotReadFailures: [{
        layerIndex: 1,
        subAccount: '0x2222222222222222222222222222222222222222',
        vault: '0x3333333333333333333333333333333333333333',
        kind: 'vaultAccount',
        cause: 'inBand',
        reason: '0x1234',
      }],
    })

    const plan = [{
      type: 'requiredApproval',
      token: '0x1111111111111111111111111111111111111111',
      owner: '0x2222222222222222222222222222222222222222',
      spender: '0x3333333333333333333333333333333333333333',
      amount: 1n,
    }] as TransactionPlan
    const simulation = useTransactionPlanSimulation()

    await expect(simulation.runSimulation(plan)).resolves.toBe(false)
    expect(simulation.simulationError.value).toBe('Token transfer failed.')
  })
})
