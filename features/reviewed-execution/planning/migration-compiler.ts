import type {
  Account,
  IHasVaultAddress,
  MigrationAuthorizationCall,
  MigrationAuthorizationRequest,
  PlanMigrationSimulationResult,
  TransactionPlan,
} from '@eulerxyz/euler-v2-sdk'
import { encodeFunctionData, getAddress, type Address, type StateOverride } from 'viem'
import type { OperationIntent } from '../domain/intents'
import type { AdditionalMaterializedCall, EffectOwner } from '../materialization/prepared-plan'
import { prepareMigrationSignatureEvidence, type Permit2TypedData, type PreparedMigrationSignatureSlot } from '../materialization/signature-slots'
import { rehydrateIntentSwapQuote, type IntentSwapQuote } from '../domain/swap-quote'
import { canonicalDigest, toCanonicalValue } from '../domain/canonical'
import type { CompiledIntentSet } from './compiler'

interface MigrationSignatureCoordinate {
  authorizationRequestIndex: number
  planItemIndex: number
  batchItemIndex: number
  abiArgumentPath: readonly (string | number)[]
}

interface ReviewedExecutionMigrationService {
  planMigrationSimulation(args: Record<string, unknown>): Promise<PlanMigrationSimulationResult>
  /**
   * SDK prerequisite: returns ABI-aware coordinates for every typed migration
   * authorization embedded in the public simulation preview.
   */
  prepareMigrationAuthorizationSlots?: (args: {
    previewPlan: TransactionPlan
    authorizationRequest: MigrationAuthorizationRequest
  }) => Promise<readonly MigrationSignatureCoordinate[]> | readonly MigrationSignatureCoordinate[]
}

export interface MigrationCompilerSdk {
  positionMigrationService: ReviewedExecutionMigrationService
}

export interface MigrationCompilationCollectors {
  /** Authorization requests are located again after plugins finish changing the plan. */
  migrationAuthorizationRequests: MigrationAuthorizationRequest[]
  before: AdditionalMaterializedCall[]
  after: AdditionalMaterializedCall[]
  stateOverrides: StateOverride
  /** SDK plan used only for simulation; signature calls are omitted and modeled with state overrides. */
  plansForSimulation: Map<string, TransactionPlan>
}

export const buildMigrationSimulationPlan = (
  intentPlans: CompiledIntentSet['intentPlans'],
  plansForSimulation: ReadonlyMap<string, TransactionPlan>,
  mergePlans: (plans: TransactionPlan[]) => TransactionPlan,
): TransactionPlan => {
  const plans = intentPlans.map(({ intentId, intentRevision, plan }) =>
    plansForSimulation.get(`${intentId}:${intentRevision}`) ?? plan,
  )
  return plans.length === 1 ? plans[0] : mergePlans(plans)
}

const flattenAuthorizationRequests = (request: MigrationAuthorizationRequest | undefined): MigrationAuthorizationRequest[] => {
  if (!request) return []
  return [request, ...flattenAuthorizationRequests(request.postMigrationAuthorization)]
}

const typedAuthorizationRequests = (request: MigrationAuthorizationRequest) =>
  flattenAuthorizationRequests(request)
    .map((candidate, authorizationRequestIndex) => ({ candidate, authorizationRequestIndex }))
    .filter((entry): entry is { candidate: Extract<MigrationAuthorizationRequest, { kind: 'typedData' }>, authorizationRequestIndex: number } => entry.candidate.kind === 'typedData')

/** Locate typed migration authorizations in the final plan the user reviews. */
export const prepareMigrationSignatureSlotsForPlan = async ({
  plan,
  authorizationRequests,
  sdk,
}: {
  plan: TransactionPlan
  authorizationRequests: readonly MigrationAuthorizationRequest[]
  sdk: MigrationCompilerSdk
}): Promise<PreparedMigrationSignatureSlot[]> => {
  if (!authorizationRequests.length) return []
  const prepareSlots = sdk.positionMigrationService.prepareMigrationAuthorizationSlots
  if (!prepareSlots) throw new Error('SDK migration authorization slot builder is unavailable')

  const result: PreparedMigrationSignatureSlot[] = []
  const usedCoordinates = new Set<string>()
  for (const request of authorizationRequests) {
    const typedRequests = typedAuthorizationRequests(request)
    const coordinates = await prepareSlots({ previewPlan: plan, authorizationRequest: request })
    for (const entry of typedRequests) {
      const matches = coordinates.filter(coordinate => coordinate.authorizationRequestIndex === entry.authorizationRequestIndex)
      if (matches.length !== 1) throw new Error('SDK migration authorization slot evidence is incomplete or ambiguous')
      const coordinate = matches[0]
      const coordinateKey = `${coordinate.planItemIndex}:${coordinate.batchItemIndex}`
      if (usedCoordinates.has(coordinateKey)) throw new Error('Migration authorization slots overlap in the reviewed plan')
      usedCoordinates.add(coordinateKey)
      result.push(prepareMigrationSignatureEvidence({
        planItemIndex: coordinate.planItemIndex,
        batchItemIndex: coordinate.batchItemIndex,
        signer: getAddress(entry.candidate.owner) as Address,
        chainId: entry.candidate.chainId,
        typedData: entry.candidate.typedData as Permit2TypedData,
        validUntil: validUntilFrom(entry.candidate),
        abiArgumentPath: coordinate.abiArgumentPath,
      }))
    }
    if (coordinates.length !== typedRequests.length) throw new Error('SDK returned undeclared migration signature coordinates')
  }
  return result
}

const validUntilFrom = (request: Extract<MigrationAuthorizationRequest, { kind: 'typedData' }>): number | undefined => {
  const message = request.typedData.message as Record<string, unknown>
  for (const key of ['deadline', 'expiry', 'validUntil']) {
    const value = message[key]
    if (typeof value === 'bigint' && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value)
    if (typeof value === 'number' && Number.isSafeInteger(value)) return value
  }
  return undefined
}

const appendTransactionAuthorization = (
  request: Extract<MigrationAuthorizationRequest, { kind: 'transaction' }>,
  owner: EffectOwner,
  collectors: MigrationCompilationCollectors,
) => {
  const encode = (call: MigrationAuthorizationCall, phase: 'prerequisite' | 'cleanup') => ({
    phase,
    chainId: request.chainId,
    to: getAddress(call.to),
    data: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args }),
    ...(call.value === undefined ? {} : { value: call.value }),
  })
  const grant = request.call ? encode(request.call, 'prerequisite') : undefined
  const revocation = request.revocation ? encode(request.revocation, 'cleanup') : undefined
  const authorizationId = canonicalDigest('migration-authorization-pair-v1', toCanonicalValue({
    owner,
    pairIndex: collectors.before.length,
    grant: grant ?? null,
    revocation: revocation ?? null,
  }))
  const decorate = (call: ReturnType<typeof encode>): AdditionalMaterializedCall => ({
    ...call,
    authorizationId,
    owner,
    provenance: { source: 'migration-authorization', mode: 'transaction' },
  })
  if (grant) collectors.before.push(decorate(grant))
  if (revocation) collectors.after.unshift(decorate(revocation))
}

const plannerArgs = (intent: OperationIntent, account: Account<IHasVaultAddress>) => {
  const args: Record<string, unknown> = { ...intent.planner.args, chainId: intent.chainId, account }
  delete args.authorizationEvidenceDigest
  for (const key of ['collateralSwapQuote', 'debtSwapQuote']) {
    if (args[key]) args[key] = rehydrateIntentSwapQuote(args[key] as IntentSwapQuote)
  }
  return args
}

/** Compile a migration once and register every authorization as explicit reviewed execution data. */
export const compileCrossProtocolMigrationIntent = async ({
  intent,
  account,
  sdk,
  collectors,
  warmedResult,
}: {
  intent: OperationIntent
  account: Account<IHasVaultAddress>
  sdk: MigrationCompilerSdk
  collectors: MigrationCompilationCollectors
  warmedResult?: PlanMigrationSimulationResult
}): Promise<TransactionPlan> => {
  const result = warmedResult ?? await sdk.positionMigrationService.planMigrationSimulation(plannerArgs(intent, account))
  collectors.plansForSimulation.set(`${intent.intentId}:${intent.revision}`, result.plan)
  collectors.stateOverrides.push(...result.stateOverrides)
  const request = result.authorizationRequest
  const authorizationEvidenceDigest = canonicalDigest('migration-authorization-evidence-v1', toCanonicalValue(request ?? null))
  if (authorizationEvidenceDigest !== intent.planner.args.authorizationEvidenceDigest) {
    throw new Error('Migration authorization requirements changed before sealing')
  }
  if (!request) return result.previewPlan

  const owner = { intentId: intent.intentId, intentRevision: intent.revision }
  const requests = flattenAuthorizationRequests(request)
  requests.filter((candidate): candidate is Extract<MigrationAuthorizationRequest, { kind: 'transaction' }> => candidate.kind === 'transaction')
    .forEach(candidate => appendTransactionAuthorization(candidate, owner, collectors))

  const typedRequests = typedAuthorizationRequests(request)
  if (!typedRequests.length) return result.plan
  await prepareMigrationSignatureSlotsForPlan({ plan: result.previewPlan, authorizationRequests: [request], sdk })
  collectors.migrationAuthorizationRequests.push(request)
  return result.previewPlan
}
