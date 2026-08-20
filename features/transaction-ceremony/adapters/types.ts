import type { Hash } from 'viem'
import type { AttemptRecord } from '../domain/attempt'
import type { SealedCeremony } from '../domain/ceremony'
import type { FinalizedArtifact } from '../domain/template'
import type { CanonicalValue } from '../domain/canonical'

export interface DispatchCallbacks {
  getAttempt(): AttemptRecord
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

export interface CeremonyTransportAdapter {
  readonly transport: 'eoa' | 'safe'
  dispatch(ceremony: SealedCeremony, artifact: FinalizedArtifact, callbacks: DispatchCallbacks): Promise<DispatchResult>
}
