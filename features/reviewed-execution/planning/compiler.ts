import { flattenBatchEntries, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import type { OperationIntent, PlannerName } from '../domain/intents'
import { assertOperationIntent } from '../domain/schemas'
import { validateIntentSet } from '../domain/validators'
import type { EffectOwner } from '../materialization/prepared-plan'
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
  effectOwners: Readonly<Record<string, EffectOwner>>
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
    const sourceOwners: { type: TransactionPlan[number]['type'], owner: EffectOwner }[] = []
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
        sourceOwners.push({ type: item.type, owner })
        if (item.type === 'evcBatch') {
          flattenBatchEntries(item.items).forEach(() => evcOwners.push(owner))
        }
      }
      plans.push(plan)
      intentPlans.push({ intentId: intent.intentId, intentRevision: intent.revision, plan })
    }
    const plan = plans.length === 1 ? plans[0] : this.mergePlans(plans)
    assertCurrent()
    const effectOwners: Record<string, EffectOwner> = {}
    const nonEvcOwners = sourceOwners.filter(source => source.type !== 'evcBatch')
    let evcIndex = 0
    let nonEvcIndex = 0
    for (const [planIndex, item] of plan.entries()) {
      if (item.type === 'evcBatch') {
        const owners = flattenBatchEntries(item.items).map(() => evcOwners[evcIndex++])
        if (owners.some(owner => !owner)) throw new Error('Merged plan expanded the EVC operation set')
        owners.forEach((owner, batchIndex) => {
          effectOwners[`${planIndex}:${batchIndex}`] = owner!
        })
        // The top-level owner is used only if the materializer cannot identify
        // an individual batch coordinate.
        if (owners[0]) effectOwners[`${planIndex}`] = owners[0]
      }
      else {
        const sourceIndex = nonEvcOwners.findIndex((source, index) => index >= nonEvcIndex && source.type === item.type)
        if (sourceIndex < 0) throw new Error('Merged plan changed a non-EVC operation')
        nonEvcIndex = sourceIndex + 1
        effectOwners[`${planIndex}`] = nonEvcOwners[sourceIndex].owner
      }
    }
    if (evcIndex !== evcOwners.length || nonEvcIndex !== nonEvcOwners.length) throw new Error('Merged plan omitted an intent effect')
    return { plan, intentPlans, effectOwners }
  }
}
