import type { Hash } from 'viem'
import type { ReviewedExecution, FinalizedRequestSet } from '../domain/reviewed-execution'

export interface DispatchCallbacks {
  assertWalletBinding(): Promise<void>
  beforeDispatch(stepIndex: number): Promise<void>
  recordExternalId(stepIndex: number, kind: 'transaction-hash' | 'calls-id' | 'execution-hash', value: string): Promise<void>
  markConfirming(stepIndex: number): Promise<void>
  afterConfirmed(stepIndex: number): Promise<void>
}

export interface DispatchResult {
  transactionHashes: readonly Hash[]
  /** Block containing the final confirmed request in this dispatch. */
  confirmedBlockNumber?: bigint
  callsId?: string
  executionHash?: Hash
  atomic?: true
}

export interface DispatchOptions {
  requestOffset?: number
  /** Original reviewed-vector indexes for a non-contiguous reviewed subset. */
  requestIndexes?: readonly number[]
}

export interface ExecutionTransportAdapter {
  readonly transport: 'eoa' | 'safe'
  dispatch(execution: ReviewedExecution, artifact: FinalizedRequestSet, callbacks: DispatchCallbacks, options?: DispatchOptions): Promise<DispatchResult>
}
