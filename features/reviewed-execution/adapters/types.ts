import type { Hash } from 'viem'
import type { SubmissionAttempt } from '../domain/submission-attempt'
import type { ReviewedExecution, FinalizedRequestSet } from '../domain/reviewed-execution'
import type { CanonicalValue } from '../domain/canonical'

export interface DispatchCallbacks {
  getAttempt(): SubmissionAttempt
  assertReservation(): Promise<void>
  assertWalletBinding(): Promise<void>
  beforeDispatch(stepIndex: number, detail?: CanonicalValue): Promise<void>
  recordExternalId(kind: 'transaction-hash' | 'calls-id' | 'execution-hash', value: string): Promise<void>
  markConfirming(stepIndex: number): Promise<void>
  afterConfirmed(stepIndex: number): Promise<void>
}

export interface DispatchResult {
  transactionHashes: readonly Hash[]
  executionHash?: Hash
}

export interface ExecutionTransportAdapter {
  readonly transport: 'eoa' | 'safe'
  dispatch(execution: ReviewedExecution, artifact: FinalizedRequestSet, callbacks: DispatchCallbacks): Promise<DispatchResult>
}
