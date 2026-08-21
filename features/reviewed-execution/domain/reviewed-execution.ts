import type { Address, Hash, Hex } from 'viem'
import type { CanonicalValue } from './canonical'
import type { EffectNode } from './effects'
import type { IntentConstraint, OperationIntent } from './intents'

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

export type SafeAtomicCapabilityStatus = 'supported' | 'ready'

export interface SafeTransportCall {
  to: Address
  data: Hex
  value: bigint
}

/** Exact EIP-5792 request inputs plus the per-chain capability evidence used to admit review. */
export interface SafeTransportEnvelope {
  schemaVersion: 1
  version: '2.0.0'
  from: Address
  chainId: number
  atomicRequired: true
  calls: readonly SafeTransportCall[]
  capabilities: Readonly<Record<string, never>>
  atomicCapability: Readonly<{ status: SafeAtomicCapabilityStatus }>
}

/** Internal request data committed by a ReviewedExecution. */
export interface ReviewedRequestSet {
  schemaVersion: 1
  wallet: WalletBinding
  effects: readonly EffectNode[]
  transport: 'eoa' | 'safe'
  requests: readonly EoaRequest[] | readonly SafeCall[]
  safeTransport?: SafeTransportEnvelope
  signatureSlots: readonly SignatureSlot[]
  pythRefreshSlots: readonly PythRefreshSlot[]
  constraints: readonly IntentConstraint[]
  policyDigest: Hash
}

/** Internal request data after signature and Pyth slots have been filled. */
export interface FinalizedRequestSet {
  readonly __finalizedRequestSet: true
  reviewId: Hash
  requestDigest: Hash
  transport: 'eoa' | 'safe'
  requests: readonly EoaRequest[] | readonly SafeCall[]
  safeTransport?: SafeTransportEnvelope
  signatureValues: readonly { slotId: Hash, signature: Hex }[]
  pythValues: readonly { slotId: Hash, payloadHash: Hash, value: bigint }[]
}

export type PolicyState
  = | { state: 'allowed', version: string, observedAt: number, expiresAt?: number }
    | { state: 'blocked', version: string, reason: string, observedAt: number }
    | { state: 'pending', version: string }
    | { state: 'unavailable', reason: string }

export interface ReviewedPolicy {
  schemaVersion: 1
  subjects: readonly { kind: string, value: string }[]
  results: readonly { subject: string, concern: string, result: PolicyState }[]
  digest: Hash
}

export interface SimulationEffectResult {
  effectId: Hash
  coverage: 'evc-state' | 'modeled-authorization' | 'independent-call' | 'not-state-simulated'
  canExecute: boolean
  assumption?: string
  error?: string
}

export interface ReviewedSimulation {
  schemaVersion: 1
  requestDigest: Hash
  observedAt: number
  blockNumber?: bigint
  canExecute: boolean
  effects: readonly SimulationEffectResult[]
  simulatedAccounts: readonly CanonicalValue[]
  simulatedVaults: readonly CanonicalValue[]
}

export interface EffectMapEntry {
  effectId: Hash
  intentId: string
  intentRevision: number
  requestId: Hash
  coverage: SimulationEffectResult['coverage']
}

export interface EffectMap {
  schemaVersion: 1
  requestDigest: Hash
  entries: readonly EffectMapEntry[]
  previewPayloadHashes: readonly Hash[]
}

export interface ReviewBinding {
  schemaVersion: 1
  reviewId: Hash
  intentRevisions: readonly { intentId: string, revision: number }[]
  presentationKind: string
  presentationDigest: Hash
}

export interface ReviewValidity {
  createdAt: number
  cartGeneration: number
  planningSnapshotDigest: Hash
  policyVersionDigest: Hash
}

export interface PluginSnapshot {
  rawPlanDigest: Hash
  previewPlanDigest: Hash
  pluginConfigurationDigest: Hash
  rawPlan: CanonicalValue
  previewPlan: CanonicalValue
}

export interface ReviewedExecution {
  schemaVersion: 1
  reviewId: Hash
  requestDigest: Hash
  reviewDigest: Hash
  intents: readonly OperationIntent[]
  requestSet: ReviewedRequestSet
  policy: ReviewedPolicy
  simulation: ReviewedSimulation
  effectMap: EffectMap
  binding: ReviewBinding
  validity: ReviewValidity
  pluginSnapshot: PluginSnapshot
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? never
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T
