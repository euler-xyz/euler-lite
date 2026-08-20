import type { Address, Hash, Hex } from 'viem'
import type { CanonicalValue } from './canonical'
import type { EffectNode } from './effects'
import type { IntentConstraint } from './intents'

export interface WalletBinding {
  chainId: number
  account: Address
  subAccounts: readonly Address[]
  connectorId: string
  connectorSessionId: string
  walletKind: 'eoa' | 'safe'
  safeAddress?: Address
  classificationVersion: string
  approvalMode: 'permit2' | 'approve'
}

export interface SignatureInsertion {
  requestId: Hash
  effectId: Hash
  batchItemIndex: number
  abiArgumentPath: readonly (string | number)[]
}

export interface SignatureSlot {
  slotId: Hash
  kind: 'permit2' | 'migration'
  signer: Address
  chainId: number
  typedData: { readonly [key: string]: CanonicalValue }
  typedDataHash: Hash
  validUntil?: number
  nonce?: bigint
  insertionPoints: readonly SignatureInsertion[]
}

export interface PythFreshnessPolicy {
  maximumAgeSeconds: number
  minimumPublishTime?: number
}

export interface DynamicCallInsertion {
  requestId: Hash
  effectId: Hash
  batchItemIndex: number
}

export interface PythRefreshSlot {
  slotId: Hash
  kind: 'pyth-update-v1'
  chainId: number
  target: Address
  selector: Hex
  requiredFeedIds: readonly Hex[]
  maxValue: bigint
  freshnessPolicy: PythFreshnessPolicy
  previewPayloadHash: Hash
  previewPublishTimes: readonly number[]
  previewValue: bigint
  sourcePlanItemIndex: number
  sourceBatchItemIndex: number
  insertionPoint: DynamicCallInsertion
}

export interface EoaRequest {
  requestId: Hash
  effectIds: readonly Hash[]
  phase: 'prerequisite' | 'core' | 'cleanup'
  chainId: number
  from: Address
  to: Address
  data: Hex
  value: bigint
}

export interface SafeCall {
  callId: Hash
  effectIds: readonly Hash[]
  phase: 'prerequisite' | 'core' | 'cleanup'
  to: Address
  data: Hex
  value: bigint
}

export type ExecutionTemplate = {
  schemaVersion: 1
  wallet: WalletBinding
  effects: readonly EffectNode[]
  transport: 'eoa' | 'safe'
  requests: readonly EoaRequest[] | readonly SafeCall[]
  signatureSlots: readonly SignatureSlot[]
  pythRefreshSlots: readonly PythRefreshSlot[]
  constraints: readonly IntentConstraint[]
  policyEvidenceDigest: Hash
}

export interface FinalizedArtifact {
  readonly __finalizedArtifact: true
  ceremonyId: Hash
  templateDigest: Hash
  transport: 'eoa' | 'safe'
  requests: readonly EoaRequest[] | readonly SafeCall[]
  signatureValues: readonly { slotId: Hash, signature: Hex }[]
  pythValues: readonly { slotId: Hash, payloadHash: Hash, value: bigint }[]
}
