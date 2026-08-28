import { flattenBatchEntries, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import type { OperationIntent, PlannerName } from '../domain/intents'
import { assertOperationIntent } from '../domain/schemas'
import { validateIntentSet } from '../domain/validators'
import type { EffectOwner, EffectOwnership } from '../materialization/prepared-plan'
import type { PlanningSnapshot } from './snapshot-loader'

export interface IntentCompilerContext {
  snapshot: PlanningSnapshot
  /** Trusted ephemeral compiler data, such as an SDK Account. It is never sealed. */
  runtime: Readonly<Record<string, unknown>>
}

export interface IntentCompiler {
  compile(intent: OperationIntent, context: IntentCompilerContext): Promise<TransactionPlan>
}

export interface CompiledIntentSet {
  plan: TransactionPlan
  /** Each intent's plan before the plans are merged into the whole cart. */
  intentPlans: readonly {
    intentId: string
    intentRevision: number
    plan: TransactionPlan
  }[]
  effectOwners: Readonly<Record<string, EffectOwnership>>
}

type RequiredApproval = Extract<TransactionPlan[number], { type: 'requiredApproval' }>

const approvalKey = (approval: RequiredApproval) => [
  getAddress(approval.token),
  getAddress(approval.owner),
  getAddress(approval.spender),
].join(':')

const appendOwner = (owners: EffectOwner[], owner: EffectOwner) => {
  if (!owners.some(candidate => candidate.intentId === owner.intentId && candidate.intentRevision === owner.intentRevision)) {
    owners.push(owner)
  }
}

export class IntentCompilerRegistry {
  constructor(
    private readonly compilers: Readonly<Partial<Record<PlannerName, IntentCompiler>>>,
    private readonly mergePlans: (plans: readonly TransactionPlan[]) => TransactionPlan,
  ) {}

  async compile(intents: readonly OperationIntent[], context: IntentCompilerContext, assertCurrent: () => void): Promise<CompiledIntentSet> {
    validateIntentSet(intents)
    const plans: TransactionPlan[] = []
    const intentPlans: CompiledIntentSet['intentPlans'][number][] = []
    const approvalSources = new Map<string, { amount: bigint, owners: EffectOwner[] }>()
    const approvalEntries: { key: string, amount: bigint, owner: EffectOwner }[] = []
    const nonApprovalOwners: { type: TransactionPlan[number]['type'], owner: EffectOwner }[] = []
    const evcOwners: EffectOwner[] = []
    for (const intent of intents) {
      assertOperationIntent(intent)
      const compiler = this.compilers[intent.planner.name]
      if (!compiler) throw new Error(`No compiler is registered for ${intent.planner.name}`)
      const plan = await compiler.compile(intent, context)
      assertCurrent()
      if (!Array.isArray(plan) || !plan.length) throw new Error(`Compiler ${intent.planner.name} produced an empty plan`)
      const owner = { intentId: intent.intentId, intentRevision: intent.revision }
      for (const item of plan) {
        if (item.type === 'requiredApproval') {
          const key = approvalKey(item)
          approvalEntries.push({ key, amount: item.amount, owner })
          const source = approvalSources.get(key) ?? { amount: 0n, owners: [] }
          source.amount += item.amount
          appendOwner(source.owners, owner)
          approvalSources.set(key, source)
        }
        else if (item.type === 'evcBatch') {
          flattenBatchEntries(item.items).forEach(() => evcOwners.push(owner))
        }
        else {
          nonApprovalOwners.push({ type: item.type, owner })
        }
      }
      plans.push(plan)
      intentPlans.push({ intentId: intent.intentId, intentRevision: intent.revision, plan })
    }
    const plansWereMerged = plans.length > 1
    const plan = plansWereMerged ? this.mergePlans(plans) : plans[0]
    assertCurrent()
    const effectOwners: Record<string, EffectOwnership> = {}
    const consumedApprovalKeys = new Set<string>()
    let approvalIndex = 0
    let evcIndex = 0
    let nonApprovalIndex = 0
    for (const [planIndex, item] of plan.entries()) {
      if (item.type === 'requiredApproval') {
        const key = approvalKey(item)
        if (!plansWereMerged) {
          const source = approvalEntries[approvalIndex++]
          if (!source || source.key !== key || source.amount !== item.amount) {
            throw new Error('Compiled plan changed a required approval')
          }
          effectOwners[`${planIndex}`] = [source.owner]
        }
        else {
          const source = approvalSources.get(key)
          if (!source || consumedApprovalKeys.has(key) || item.amount !== source.amount) {
            throw new Error('Merged plan changed a required approval')
          }
          consumedApprovalKeys.add(key)
          effectOwners[`${planIndex}`] = source.owners
        }
      }
      else if (item.type === 'evcBatch') {
        const owners = flattenBatchEntries(item.items).map(() => evcOwners[evcIndex++])
        if (owners.some(owner => !owner)) throw new Error('Merged plan expanded the EVC operation set')
        owners.forEach((owner, batchIndex) => {
          effectOwners[`${planIndex}:${batchIndex}`] = [owner!]
        })
        // The top-level owner is used only if the materializer cannot identify
        // an individual batch coordinate.
        if (owners[0]) effectOwners[`${planIndex}`] = [owners[0]]
      }
      else {
        const sourceIndex = nonApprovalOwners.findIndex((source, index) => index >= nonApprovalIndex && source.type === item.type)
        if (sourceIndex < 0) throw new Error('Merged plan changed a non-EVC operation')
        nonApprovalIndex = sourceIndex + 1
        effectOwners[`${planIndex}`] = [nonApprovalOwners[sourceIndex].owner]
      }
    }
    if (
      (plansWereMerged ? consumedApprovalKeys.size !== approvalSources.size : approvalIndex !== approvalEntries.length)
      || evcIndex !== evcOwners.length
      || nonApprovalIndex !== nonApprovalOwners.length
    ) throw new Error('Merged plan omitted an intent effect')
    return { plan, intentPlans, effectOwners }
  }
}
