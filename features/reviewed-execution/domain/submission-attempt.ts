import type { Address, Hash } from 'viem'

export type SubmissionState
  = | 'accepted'
    | 'reserved'
    | 'revalidating'
    | 'signing'
    | 'finalized'
    | 'dispatching'
    | 'identified'
    | 'confirming'
    | 'succeeded'
    | 'safely-rejected-before-dispatch'
    | 'reverted'
    | 'cancelled-proven'
    | 'expired'
    | 'cleanup-required'
    | 'recovery-required'

export interface SubmissionAttempt {
  schemaVersion: 1
  attemptId: string
  reviewId: Hash
  requestDigest: Hash
  state: SubmissionState
  account: Address
  chainId: number
  laneKey: string
  reservationId: string
  version: number
  fence: number
  stepIndex: number
  createdAt: number
  updatedAt: number
  externalIds: readonly { kind: 'transaction-hash' | 'calls-id' | 'execution-hash', value: string }[]
  error?: string
}
