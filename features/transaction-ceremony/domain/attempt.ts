import type { Address, Hash } from 'viem'

export type AttemptState
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

export interface AttemptRecord {
  schemaVersion: 1
  attemptId: string
  ceremonyId: Hash
  templateDigest: Hash
  state: AttemptState
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
