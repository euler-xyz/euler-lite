import type { Address, Hash, Hex } from 'viem'

export type EffectPhase = 'prerequisite' | 'core' | 'cleanup'

export type EffectProvenance
  = | { source: 'intent', planner: string }
    | { source: 'sdk-plugin', plugin: 'pyth' | 'keyring' }
    | { source: 'lite-plugin', plugin: 'tos' }
    | { source: 'migration-authorization', mode: 'signature' | 'transaction' }

export type SimulationCoverage
  = | { kind: 'evc-state' }
    | { kind: 'modeled-authorization', assumption: string }
    | { kind: 'independent-call' }
    | { kind: 'not-state-simulated', allowlistId: string }

export interface EffectPolicySubject {
  kind: 'account' | 'vault-or-contract' | 'asset' | 'spender' | 'pyth-feed' | 'authority'
  value: string
}

export type TypedEffect
  = | {
    kind: 'approval'
    mode: 'transaction' | 'permit2'
    owner: Address
    token: Address
    spender: Address
    amount: bigint
  }
  | {
    kind: 'evc-call'
    target: Address
    onBehalfOfAccount: Address
    value: bigint
    data: Hex
    selector: Hex
  }
  | {
    kind: 'direct-call'
    chainId: number
    target: Address
    value: bigint
    data: Hex
    selector: Hex
  }
  | {
    kind: 'tos-call'
    target: Address
    onBehalfOfAccount: Address
    value: bigint
    data: Hex
    selector: Hex
  }
  | {
    kind: 'keyring-call'
    target: Address
    onBehalfOfAccount: Address
    value: bigint
    data: Hex
    selector: Hex
  }
  | {
    kind: 'pyth-update'
    chainId: number
    target: Address
    onBehalfOfAccount: Address
    value: bigint
    data: Hex
    selector: Hex
    requiredFeedIds: readonly Hex[]
  }
  | {
    kind: 'migration-authorization'
    action: 'grant' | 'revoke'
    authorizationId: Hash
    chainId: number
    target: Address
    value: bigint
    data: Hex
  }

export interface EffectNode {
  effectId: Hash
  /** Additional provenance when plan merging coalesces multiple prerequisites. */
  intentRefs?: readonly { intentId: string, intentRevision: number }[]
  /** Primary intent retained for the one-effect/one-row compatibility map. */
  intentId: string
  intentRevision: number
  dependsOn: readonly Hash[]
  phase: EffectPhase
  effect: TypedEffect
  provenance: EffectProvenance
  simulation: SimulationCoverage
  /** Exhaustive, compiler/materializer-owned subjects carried by this effect. */
  policySubjects: readonly EffectPolicySubject[]
}
