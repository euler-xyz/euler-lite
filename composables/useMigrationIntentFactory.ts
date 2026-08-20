import type { MigrationAuthorizationRequest, PlanMigrationSimulationResult, PluginPrefetchData, SwapQuote, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import type { Address } from 'viem'
import type { IntentConstraint, OperationIntent } from '~/features/transaction-ceremony/domain/intents'
import { canonicalDigest, toCanonicalValue } from '~/features/transaction-ceremony/domain/canonical'
import {
  bindEagerPlanIntents,
  publishEagerMigrationCompilation,
  publishEagerPluginPrefetch,
  publishEagerPreparedPlan,
} from '~/features/transaction-ceremony/planning/eager-plan-intents'
import { serializePluginPrefetch } from '~/features/transaction-ceremony/planning/plugin-evidence'

export interface CreateMigrationIntentInput {
  args: Readonly<Record<string, unknown>>
  authorizationRequest?: MigrationAuthorizationRequest
  source: string
  subAccounts: readonly Address[]
  bounds: readonly IntentConstraint[]
  eagerCompilation?: {
    result: PlanMigrationSimulationResult
    observedBlock: bigint
    prefetch?: PluginPrefetchData
    prepared?: TransactionPlanPrepared
  }
}

const quoteConstraints = (quote: SwapQuote | undefined): IntentConstraint[] => quote
  ? [
      { kind: 'maximum-input', token: quote.tokenIn.address as Address, amount: BigInt(quote.amountInMax) },
      { kind: 'minimum-output', token: quote.tokenOut.address as Address, amount: BigInt(quote.amountOutMin) },
      { kind: 'deadline', timestamp: quote.verify.deadline },
    ]
  : []

/** Captures a fully bounded cross-protocol migration intent at the page action boundary. */
export const useMigrationIntentFactory = () => {
  const { create } = useOperationIntentFactory()

  const createMigrationIntent = (input: CreateMigrationIntentInput): Readonly<OperationIntent> => {
    const collateralSwapQuote = input.args.collateralSwapQuote as SwapQuote | undefined
    const debtSwapQuote = input.args.debtSwapQuote as SwapQuote | undefined
    const authorizationRequests = (request: MigrationAuthorizationRequest | undefined): MigrationAuthorizationRequest[] => request
      ? [request, ...authorizationRequests(request.postMigrationAuthorization)]
      : []
    const typedDeadline = authorizationRequests(input.authorizationRequest).find(request => request.kind === 'typedData')
    const rawDeadline = typedDeadline?.kind === 'typedData'
      ? (typedDeadline.typedData.message as Record<string, unknown>).deadline
      : undefined
    const deadline = typeof rawDeadline === 'bigint'
      ? rawDeadline
      : BigInt(Math.floor(Date.now() / 1000) + 60 * 60)
    if (deadline > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Migration deadline is out of range')
    const args = {
      ...input.args,
      deadline,
      authorizationEvidenceDigest: canonicalDigest('migration-authorization-evidence-v1', toCanonicalValue(input.authorizationRequest ?? null)),
    }
    const intent = create({
      kind: 'migration',
      planner: 'cross-protocol-migration',
      args,
      source: input.source,
      subAccounts: input.subAccounts,
      constraints: [
        ...input.bounds,
        ...quoteConstraints(collateralSwapQuote),
        ...quoteConstraints(debtSwapQuote),
        { kind: 'deadline', timestamp: Number(deadline) },
      ],
    })
    if (input.eagerCompilation) {
      const { result, observedBlock, prefetch, prepared } = input.eagerCompilation
      publishEagerMigrationCompilation(intent, result, observedBlock)
      const requests = authorizationRequests(result.authorizationRequest)
      const rawPlan = requests.some(request => request.kind === 'typedData') ? result.previewPlan : result.plan
      bindEagerPlanIntents(rawPlan, [intent])
      if (prefetch) publishEagerPluginPrefetch(rawPlan, serializePluginPrefetch(prefetch))
      if (prepared) publishEagerPreparedPlan(rawPlan, prepared)
    }
    return intent
  }

  return { createMigrationIntent }
}
