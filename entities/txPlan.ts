import type { Address, Abi } from 'viem'

export type TxStepType
  = | 'approve'
    | 'permit2-approve'
    | 'evc-batch'
    | 'other'

export interface TxStep {
  type: TxStepType
  label?: string
  to: Address
  abi: Abi
  functionName: string
  args: readonly unknown[]
  value?: bigint
}

export interface TxPlan {
  kind: 'supply' | 'withdraw' | 'borrow' | 'repay' | 'full-repay' | 'disable-collateral' | 'reward' | 'brevis-reward' | 'reul-unlock' | 'swap-supply' | 'swap-withdraw' | 'swap-borrow' | string
  steps: TxStep[]
}
