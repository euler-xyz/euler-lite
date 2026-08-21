import { zeroHash, type Hash } from 'viem'
import { flattenBatchEntries, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { canonicalDigest, toCanonicalValue, type CanonicalValue } from '../domain/canonical'
import type { ReviewedPolicy, ReviewedExecution, PluginSnapshot, ReviewedRequestSet, ReviewedSimulation, SafeAtomicCapabilityStatus, WalletBinding } from '../domain/reviewed-execution'
import type { OperationIntent } from '../domain/intents'
import { assertReviewedExecutionIntegrity, sealReviewedExecution } from '../domain/seal'
import type { AdditionalMaterializedCall, EffectOwner, PlanMaterializationSdk, PythPreviewData } from '../materialization/prepared-plan'
import { reviewedRequestDigest, materializePreparedPlan } from '../materialization/prepared-plan'
import type { PreparedMigrationSignatureSlot, PreparedPermit2Slot } from '../materialization/signature-slots'
import type { EulerSimulationProjection } from '../simulation/coverage'
import { buildReviewedSimulation } from '../simulation/coverage'
import type { GenerationPublisher, PreparationCache, PreparationCacheIdentity } from './cache'
import { collectPlanningRequirements } from './requirements'
import type { IntentCompilerRegistry } from './compiler'
import type { PlanningSnapshot, PlanningSnapshotLoader } from './snapshot-loader'

export interface ReviewedExecutionDependencies {
  compiler: IntentCompilerRegistry
  snapshotLoader: PlanningSnapshotLoader
  materializationSdk: PlanMaterializationSdk
  prefetchPlugins(plan: TransactionPlan, wallet: WalletBinding, snapshot: PlanningSnapshot): Promise<CanonicalValue>
  processPlugins(plan: TransactionPlan, wallet: WalletBinding, prefetched: CanonicalValue): Promise<TransactionPlan>
  resolveApprovals(plan: TransactionPlan, wallet: WalletBinding, snapshot: PlanningSnapshot): Promise<TransactionPlan>
  preparePermit2Slots(plan: TransactionPlan, wallet: WalletBinding, snapshot: PlanningSnapshot): Promise<readonly PreparedPermit2Slot[]>
  prepareMigrationSignatureSlots(plan: TransactionPlan, wallet: WalletBinding, snapshot: PlanningSnapshot): Promise<readonly PreparedMigrationSignatureSlot[]>
  collectPythEvidence(plan: TransactionPlan, wallet: WalletBinding, snapshot: PlanningSnapshot, prefetched: CanonicalValue): Promise<readonly PythPreviewData[]>
  resolvePolicy(requestSet: ReviewedRequestSet, snapshot: PlanningSnapshot): Promise<ReviewedPolicy>
  simulate(plan: TransactionPlan, requestSet: ReviewedRequestSet, snapshot: PlanningSnapshot, rawPlan: TransactionPlan): Promise<EulerSimulationProjection | undefined>
  pluginConfiguration: CanonicalValue
  directCallAllowlist?: Readonly<Record<string, string>>
}

export interface PrepareReviewedExecutionRequest {
  intents: readonly OperationIntent[]
  wallet: WalletBinding
  cartGeneration: number
  runtime: Readonly<Record<string, unknown>>
  presentationKind: string
  presentationInputs: CanonicalValue
  compilerVersion: string
  policyVersionDigest: Hash
  freshUntil: number
  safeAtomicCapability?: Readonly<{ status: SafeAtomicCapabilityStatus }>
  before?: readonly AdditionalMaterializedCall[]
  after?: readonly AdditionalMaterializedCall[]
  adopt?: PreparationCacheIdentity
  /** Rechecks mutable wallet/session context at every asynchronous boundary. */
  assertContext?: () => Promise<void>
}

const pluginOwnerMap = (
  raw: TransactionPlan,
  preview: TransactionPlan,
  rawOwners: Readonly<Record<string, EffectOwner>>,
  fallback: EffectOwner,
): Readonly<Record<string, EffectOwner>> => {
  if (raw.length !== preview.length) throw new Error('Plugin processing changed the top-level plan shape')
  const result: Record<string, EffectOwner> = {}
  for (const [previewPlanIndex, previewItem] of preview.entries()) {
    const rawItem = raw[previewPlanIndex]
    if (!rawItem || rawItem.type !== previewItem.type) throw new Error('Plugin processing reordered static plan items')
    if (previewItem.type === 'evcBatch' && rawItem?.type === 'evcBatch') {
      const previewItems = flattenBatchEntries(previewItem.items)
      const rawItems = flattenBatchEntries(rawItem.items)
      if (previewItems.length < rawItems.length) throw new Error('Plugin processing removed EVC effects')
      const prefix = previewItems.length - rawItems.length
      previewItems.forEach((_item, batchIndex) => {
        result[`${previewPlanIndex}:${batchIndex}`] = batchIndex < prefix
          ? fallback
          : rawOwners[`${previewPlanIndex}:${batchIndex - prefix}`] ?? rawOwners[`${previewPlanIndex}`] ?? fallback
      })
      result[`${previewPlanIndex}`] = result[`${previewPlanIndex}:0`] ?? fallback
      continue
    }
    // Approval resolution is an expected deterministic transformation. Direct
    // calls are later byte-checked by materialization and the Pyth verifier.
    result[`${previewPlanIndex}`] = rawOwners[`${previewPlanIndex}`] ?? fallback
  }
  return result
}

const cacheIdentity = (
  request: PrepareReviewedExecutionRequest,
  snapshot: PlanningSnapshot,
  stage: PreparationCacheIdentity['stage'],
  requestDigest?: Hash,
): PreparationCacheIdentity => ({
  schemaVersion: 1,
  stage,
  intentSetHash: snapshot.intentSetHash,
  cartGeneration: request.cartGeneration,
  owner: request.wallet.account,
  chainId: request.wallet.chainId,
  accounts: request.wallet.subAccounts,
  connectorId: request.wallet.connectorId,
  connectorSessionId: request.wallet.connectorSessionId,
  observedBlock: snapshot.observedBlock,
  dataSourceVersions: snapshot.dataSourceVersions,
  compilerVersion: request.compilerVersion,
  policyVersionDigest: request.policyVersionDigest,
  presentationDigest: canonicalDigest('review-presentation-v1', toCanonicalValue({
    kind: request.presentationKind,
    inputs: request.presentationInputs,
  })),
  ...(requestDigest ? { requestDigest } : {}),
  freshUntil: request.freshUntil,
})

export class ReviewedExecutionPreparationService {
  private readonly adoptionIdentities = new Map<Hash, PreparationCacheIdentity>()

  constructor(
    private readonly dependencies: ReviewedExecutionDependencies,
    private readonly cache: PreparationCache,
    private readonly generation: GenerationPublisher,
    private readonly now: () => number = Date.now,
  ) {}

  getAdoptionIdentity(reviewId: Hash): PreparationCacheIdentity | undefined {
    const identity = this.adoptionIdentities.get(reviewId)
    return identity ? { ...identity, accounts: [...identity.accounts], dataSourceVersions: { ...identity.dataSourceVersions } } : undefined
  }

  async prepare(request: PrepareReviewedExecutionRequest): Promise<Readonly<ReviewedExecution>> {
    const assertCurrent = () => this.generation.assertCurrent(request.cartGeneration)
    const assertContext = async () => {
      assertCurrent()
      await request.assertContext?.()
      assertCurrent()
    }
    await assertContext()
    if (request.adopt) {
      const cached = this.cache.get(request.adopt, this.now())
      if (cached) {
        assertReviewedExecutionIntegrity(cached)
        if (cached.validity.cartGeneration !== request.cartGeneration || cached.validity.policyVersionDigest !== request.policyVersionDigest) throw new Error('Cached reviewed execution identity is incomplete')
        await assertContext()
        return cached
      }
    }

    const requirements = collectPlanningRequirements(request.intents)
    const snapshot = await this.dependencies.snapshotLoader.load(requirements, request.cartGeneration, this.now())
    await assertContext()
    const compiled = await this.dependencies.compiler.compile(request.intents, { snapshot, runtime: request.runtime }, assertCurrent)
    await assertContext()

    const pluginIdentity = cacheIdentity(request, snapshot, 'plugins')
    let prefetched = this.cache.get(pluginIdentity, this.now())
    if (!prefetched) {
      prefetched = await this.dependencies.prefetchPlugins(compiled.plan, request.wallet, snapshot)
      await assertContext()
      this.cache.put(pluginIdentity, prefetched)
    }
    const preview = await this.dependencies.processPlugins(compiled.plan, request.wallet, prefetched)
    await assertContext()
    const resolved = await this.dependencies.resolveApprovals(preview, request.wallet, snapshot)
    await assertContext()
    const [permit2Slots, migrationSignatureSlots, pythPreviewData] = await Promise.all([
      this.dependencies.preparePermit2Slots(resolved, request.wallet, snapshot),
      this.dependencies.prepareMigrationSignatureSlots(resolved, request.wallet, snapshot),
      this.dependencies.collectPythEvidence(resolved, request.wallet, snapshot, prefetched),
    ])
    await assertContext()
    const fallbackOwner = { intentId: request.intents[0].intentId, intentRevision: request.intents[0].revision }
    const effectOwners = pluginOwnerMap(compiled.plan, resolved, compiled.effectOwners, fallbackOwner)
    const materialize = (policyDigest: Hash) => materializePreparedPlan({
      intents: request.intents,
      plan: resolved,
      wallet: request.wallet,
      sdk: this.dependencies.materializationSdk,
      permit2Slots,
      migrationSignatureSlots,
      pythPreviewData,
      effectOwners,
      before: request.before,
      after: request.after,
      directCallAllowlist: this.dependencies.directCallAllowlist,
      safeAtomicCapability: request.safeAtomicCapability,
      policyDigest,
    })
    const preliminary = materialize(zeroHash)
    const policy = await this.dependencies.resolvePolicy(preliminary, snapshot)
    await assertContext()
    const requestSet = materialize(policy.digest)
    const requestDigest = reviewedRequestDigest(requestSet)
    const adoptionIdentity = cacheIdentity(request, snapshot, 'reviewed-execution', requestDigest)
    const cachedExecution = this.cache.get(adoptionIdentity, this.now())
    if (cachedExecution) {
      assertReviewedExecutionIntegrity(cachedExecution)
      if (cachedExecution.requestDigest !== requestDigest
        || cachedExecution.validity.cartGeneration !== request.cartGeneration
        || cachedExecution.validity.planningSnapshotDigest !== snapshot.digest
        || cachedExecution.validity.policyVersionDigest !== request.policyVersionDigest) {
        throw new Error('Cached reviewed execution identity is incomplete')
      }
      await assertContext()
      this.adoptionIdentities.set(cachedExecution.reviewId, adoptionIdentity)
      return cachedExecution
    }
    const simulationIdentity = cacheIdentity(request, snapshot, 'whole-cart-simulation', requestDigest)
    let simulation: ReviewedSimulation
    const cachedSimulation = this.cache.get(simulationIdentity, this.now())
    if (cachedSimulation) {
      simulation = cachedSimulation as unknown as ReviewedSimulation
      if (simulation.requestDigest !== requestDigest) throw new Error('Cached simulation belongs to another request set')
    }
    else {
      const projection = await this.dependencies.simulate(resolved, requestSet, snapshot, compiled.plan)
      await assertContext()
      simulation = buildReviewedSimulation({ requestSet, requestDigest, projection, observedAt: this.now() })
      this.cache.put(simulationIdentity, toCanonicalValue(simulation))
    }
    if (!simulation.canExecute) throw new Error('Reviewed transaction cannot execute')

    const rawCanonical = toCanonicalValue(compiled.plan)
    const previewCanonical = toCanonicalValue(resolved)
    const plugins: PluginSnapshot = {
      rawPlan: rawCanonical,
      previewPlan: previewCanonical,
      rawPlanDigest: canonicalDigest('plugin-raw-v1', rawCanonical),
      previewPlanDigest: canonicalDigest('plugin-preview-v1', previewCanonical),
      pluginConfigurationDigest: canonicalDigest('plugin-configuration-v1', this.dependencies.pluginConfiguration),
    }
    const execution = sealReviewedExecution({
      intents: request.intents,
      requestSet: requestSet,
      policy: policy,
      simulation,
      pluginSnapshot: plugins,
      validity: {
        createdAt: this.now(),
        cartGeneration: request.cartGeneration,
        planningSnapshotDigest: snapshot.digest,
        policyVersionDigest: request.policyVersionDigest,
      },
      presentationKind: request.presentationKind,
      presentationInputs: request.presentationInputs,
    })
    await assertContext()
    this.cache.put(adoptionIdentity, toCanonicalValue(execution))
    this.adoptionIdentities.set(execution.reviewId, adoptionIdentity)
    return execution
  }
}
