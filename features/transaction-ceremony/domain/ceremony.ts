import type { Hash } from 'viem'
import type { CanonicalValue } from './canonical'
import type { OperationIntent } from './intents'
import type { ExecutionTemplate } from './template'

export type EvidenceState
  = | { state: 'allowed', version: string, observedAt: number, expiresAt?: number }
    | { state: 'blocked', version: string, reason: string, observedAt: number }
    | { state: 'pending', version: string }
    | { state: 'unavailable', reason: string }

export interface PolicyEvidenceBundle {
  schemaVersion: 1
  subjects: readonly { kind: string, value: string }[]
  evidence: readonly { subject: string, concern: string, result: EvidenceState }[]
  digest: Hash
}

export interface SimulationEffectResult {
  effectId: Hash
  coverage: 'evc-state' | 'modeled-authorization' | 'independent-call' | 'not-state-simulated'
  canExecute: boolean
  assumption?: string
  error?: string
}

export interface SimulationCertificate {
  schemaVersion: 1
  templateDigest: Hash
  observedAt: number
  blockNumber?: bigint
  canExecute: boolean
  effects: readonly SimulationEffectResult[]
  simulatedAccounts: readonly CanonicalValue[]
  simulatedVaults: readonly CanonicalValue[]
}

export interface CeremonyManifestEntry {
  effectId: Hash
  intentId: string
  intentRevision: number
  requestId: Hash
  coverage: SimulationEffectResult['coverage']
}

export interface CeremonyManifest {
  schemaVersion: 1
  templateDigest: Hash
  entries: readonly CeremonyManifestEntry[]
  previewPayloadHashes: readonly Hash[]
}

export interface OperationReviewBinding {
  schemaVersion: 1
  ceremonyId: Hash
  intentRevisions: readonly { intentId: string, revision: number }[]
  presentationKind: string
  presentationDigest: Hash
}

export interface CeremonyValidity {
  createdAt: number
  expiresAt?: number
  cartGeneration: number
  planningSnapshotDigest: Hash
  policyVersionDigest: Hash
}

export interface SealedPluginEnvelope {
  rawPlanDigest: Hash
  previewPlanDigest: Hash
  pluginConfigurationDigest: Hash
  rawPlan: CanonicalValue
  previewPlan: CanonicalValue
}

export interface SealedCeremony {
  schemaVersion: 1
  ceremonyId: Hash
  templateDigest: Hash
  consentDigest: Hash
  intents: readonly OperationIntent[]
  template: ExecutionTemplate
  policyEvidence: PolicyEvidenceBundle
  simulation: SimulationCertificate
  internalManifest: CeremonyManifest
  reviewBinding: OperationReviewBinding
  validity: CeremonyValidity
  plugins: SealedPluginEnvelope
}

export type DeepReadonly<T> = T extends (...args: never[]) => unknown
  ? never
  : T extends readonly (infer U)[]
    ? readonly DeepReadonly<U>[]
    : T extends object
      ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
      : T
