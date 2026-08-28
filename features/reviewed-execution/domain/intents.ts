import type { Address, Hex } from 'viem'
import type { CanonicalValue } from './canonical'

export const OPERATION_INTENT_KINDS = [
  'deposit',
  'withdraw',
  'borrow',
  'repay',
  'collateral',
  'swap',
  'refinance',
  'migration',
  'reward-claim',
  'reul-unlock',
] as const

export type OperationIntentKind = typeof OPERATION_INTENT_KINDS[number]

export type PlannerName
  = | 'deposit'
    | 'deposit-with-swap'
    | 'withdraw'
    | 'redeem'
    | 'withdraw-and-swap'
    | 'redeem-and-swap'
    | 'borrow'
    | 'swap-and-borrow'
    | 'repay-from-wallet'
    | 'repay-from-deposit'
    | 'repay-with-swap'
    | 'swap-and-repay'
    | 'swap-from-wallet'
    | 'swap-collateral'
    | 'swap-debt'
    | 'refinance-position'
    | 'migrate-same-asset-collateral'
    | 'migrate-same-asset-debt'
    | 'multiply-with-swap'
    | 'multiply-same-asset'
    | 'transfer'
    | 'cleanup'
    | 'cross-protocol-migration'
    | 'reward-claim'
    | 'reul-unlock'

export interface IntentPlannerInput {
  name: PlannerName
  /**
   * Immutable public-planner arguments. The compiler validates the exact
   * planner-specific keys before calling the SDK; this outer DTO remains free
   * of SDK Account instances, callbacks, providers, and Vue refs.
   */
  args: { readonly [key: string]: CanonicalValue }
}

export type IntentConstraint
  = | { kind: 'exact-input', token: Address, amount: bigint }
    | { kind: 'maximum-input', token: Address, amount: bigint }
    | { kind: 'minimum-output', token: Address, amount: bigint }
    | { kind: 'share-bound', vault: Address, maximumShares: bigint }
    | { kind: 'deadline', timestamp: number }
    | { kind: 'selected-rewards', claimIds: readonly string[] }
    | { kind: 'remainder-loss', token: Address, maximumLoss: bigint }

export interface OperationIntent {
  schemaVersion: 1
  intentId: string
  revision: number
  kind: OperationIntentKind
  chainId: number
  account: Address
  subAccounts: readonly Address[]
  planner: IntentPlannerInput
  constraints: readonly IntentConstraint[]
  metadata: {
    createdAt: number
    source: string
    quoteId?: string
    quoteCalldataDigest?: Hex
  }
}

export interface BatchDraftEntry {
  intentId: string
  revision: number
  intent: OperationIntent
}
