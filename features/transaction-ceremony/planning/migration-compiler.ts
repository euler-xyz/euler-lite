import type {
  Account,
  IHasVaultAddress,
  MigrationAuthorizationRequest,
  PlanMigrationSimulationResult,
  TransactionPlan,
} from '@eulerxyz/euler-v2-sdk'
import { encodeFunctionData, getAddress, type Address, type StateOverride } from 'viem'
import type { OperationIntent } from '../domain/intents'
import type { AdditionalMaterializedCall, EffectOwner } from '../materialization/prepared-plan'
import { prepareMigrationSignatureEvidence, type Permit2TypedData, type PreparedMigrationSignatureSlot } from '../materialization/signature-slots'
import { rehydrateCeremonySwapQuote, type CeremonySwapQuote } from '../domain/swap-quote'
import { canonicalDigest, toCanonicalValue } from '../domain/canonical'

interface MigrationSignatureCoordinate {
  authorizationRequestIndex: number
  planItemIndex: number
  batchItemIndex: number
  abiArgumentPath: readonly (string | number)[]
}

interface CeremonyPositionMigrationService {
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
  positionMigrationService: CeremonyPositionMigrationService
}

export interface MigrationCompilationCollectors {
  migrationSlots: PreparedMigrationSignatureSlot[]
  before: AdditionalMaterializedCall[]
  after: AdditionalMaterializedCall[]
  stateOverrides: StateOverride
}

const flattenAuthorizationRequests = (request: MigrationAuthorizationRequest | undefined): MigrationAuthorizationRequest[] => {
  if (!request) return []
  return [request, ...flattenAuthorizationRequests(request.postMigrationAuthorization)]
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
  const encode = (call: typeof request.call, phase: 'prerequisite' | 'cleanup'): AdditionalMaterializedCall => ({
    phase,
    owner,
    provenance: { source: 'migration-authorization', mode: 'transaction' },
    chainId: request.chainId,
    to: getAddress(call.to),
    data: encodeFunctionData({ abi: call.abi, functionName: call.functionName, args: call.args }),
    ...(call.value === undefined ? {} : { value: call.value }),
  })
  collectors.before.push(encode(request.call, 'prerequisite'))
  if (request.revocation) collectors.after.unshift(encode(request.revocation, 'cleanup'))
}

const plannerArgs = (intent: OperationIntent, account: Account<IHasVaultAddress>) => {
  const args: Record<string, unknown> = { ...intent.planner.args, chainId: intent.chainId, account }
  delete args.authorizationEvidenceDigest
  for (const key of ['collateralSwapQuote', 'debtSwapQuote']) {
    if (args[key]) args[key] = rehydrateCeremonySwapQuote(args[key] as CeremonySwapQuote)
  }
  return args
}

/** Compile a migration once and register every authorization as explicit ceremony evidence. */
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

  const typedRequests = requests
    .map((candidate, authorizationRequestIndex) => ({ candidate, authorizationRequestIndex }))
    .filter((entry): entry is { candidate: Extract<MigrationAuthorizationRequest, { kind: 'typedData' }>, authorizationRequestIndex: number } => entry.candidate.kind === 'typedData')
  if (!typedRequests.length) return result.plan

  const prepareSlots = sdk.positionMigrationService.prepareMigrationAuthorizationSlots
  if (!prepareSlots) throw new Error('SDK migration authorization slot builder is unavailable')
  const coordinates = await prepareSlots({ previewPlan: result.previewPlan, authorizationRequest: request })
  for (const entry of typedRequests) {
    const matches = coordinates.filter(coordinate => coordinate.authorizationRequestIndex === entry.authorizationRequestIndex)
    if (matches.length !== 1) throw new Error('SDK migration authorization slot evidence is incomplete or ambiguous')
    const coordinate = matches[0]
    collectors.migrationSlots.push(prepareMigrationSignatureEvidence({
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
  return result.previewPlan
}
