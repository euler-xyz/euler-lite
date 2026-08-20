import type { Account, IHasVaultAddress } from '@eulerxyz/euler-v2-sdk'
import type { Address } from 'viem'
import { snapshotAccount, snapshotVaults } from '../planning/app-snapshot'
import type { EulerSimulationProjection } from './coverage'

interface EulerSimulationResultLike {
  canExecute: boolean
  simulatedAccounts?: readonly Account<IHasVaultAddress>[]
  simulatedVaults?: readonly {
    address: Address
    asset?: { address?: Address }
    totalShares?: bigint
    totalAssets?: bigint
  }[]
  failedBatchItems?: readonly unknown[]
  accountStatusErrors?: readonly unknown[]
  vaultStatusErrors?: readonly unknown[]
  simulationError?: unknown
  snapshotReadFailures?: readonly unknown[]
}

/** Normalize the SDK result once so eager and authoritative paths agree exactly. */
export const projectEulerSimulation = (result: EulerSimulationResultLike): EulerSimulationProjection => ({
  canExecute: result.canExecute
    && !result.failedBatchItems?.length
    && !result.accountStatusErrors?.length
    && !result.vaultStatusErrors?.length
    && !result.simulationError
    && !result.snapshotReadFailures?.length,
  simulatedAccounts: (result.simulatedAccounts ?? []).map(snapshotAccount),
  simulatedVaults: snapshotVaults(result.simulatedVaults ?? []),
})
