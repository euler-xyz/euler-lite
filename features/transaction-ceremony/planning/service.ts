import { zeroHash, type Hash } from 'viem'
import { flattenBatchEntries, type TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { canonicalDigest, toCanonicalValue, type CanonicalValue } from '../domain/canonical'
import type { PolicyEvidenceBundle, SealedCeremony, SealedPluginEnvelope, SimulationCertificate } from '../domain/ceremony'
import type { OperationIntent } from '../domain/intents'
import { assertCeremonyIntegrity, sealCeremony } from '../domain/seal'
import type { ExecutionTemplate, WalletBinding } from '../domain/template'
import type { AdditionalMaterializedCall, EffectOwner, PlanMaterializationSdk, PythPreviewEvidence } from '../materialization/prepared-plan'
import { executionTemplateDigest, materializePreparedPlan } from '../materialization/prepared-plan'
import type { PreparedMigrationSignatureSlot, PreparedPermit2Slot } from '../materialization/signature-slots'
import type { EulerSimulationProjection } from '../simulation/coverage'
import { buildSimulationCertificate } from '../simulation/coverage'
import type { GenerationPublisher, PreparationCache, PreparationCacheIdentity } from './cache'
import { collectPlanningRequirements } from './requirements'
import type { IntentCompilerRegistry } from './compiler'
import type { PlanningSnapshot, PlanningSnapshotLoader } from './snapshot-loader'

export interface CeremonyPreparationDependencies {
  compiler: IntentCompilerRegistry
  snapshotLoader: PlanningSnapshotLoader
  materializationSdk: PlanMaterializationSdk
  prefetchPlugins(plan: TransactionPlan, wallet: WalletBinding, snapshot: PlanningSnapshot): Promise<CanonicalValue>
  processPlugins(plan: TransactionPlan, wallet: WalletBinding, prefetched: CanonicalValue): Promise<TransactionPlan>
  resolveApprovals(plan: TransactionPlan, wallet: WalletBinding, snapshot: PlanningSnapshot): Promise<TransactionPlan>
  preparePermit2Slots(plan: TransactionPlan, wallet: WalletBinding, snapshot: PlanningSnapshot): Promise<readonly PreparedPermit2Slot[]>
  prepareMigrationSignatureSlots(plan: TransactionPlan, wallet: WalletBinding, snapshot: PlanningSnapshot): Promise<readonly PreparedMigrationSignatureSlot[]>
  collectPythEvidence(plan: TransactionPlan, wallet: WalletBinding, snapshot: PlanningSnapshot, prefetched: CanonicalValue): Promise<readonly PythPreviewEvidence[]>
  resolvePolicy(template: ExecutionTemplate, snapshot: PlanningSnapshot): Promise<PolicyEvidenceBundle>
  simulate(plan: TransactionPlan, template: ExecutionTemplate, snapshot: PlanningSnapshot, rawPlan: TransactionPlan): Promise<EulerSimulationProjection | undefined>
  pluginConfiguration: CanonicalValue
  directCallAllowlist?: Readonly<Record<string, string>>
}

export interface CeremonyPreparationRequest {
  intents: readonly OperationIntent[]
  wallet: WalletBinding
  cartGeneration: number
  runtime: Readonly<Record<string, unknown>>
  presentationKind: string
  presentationInputs: CanonicalValue
  compilerVersion: string
  policyVersionDigest: Hash
  freshUntil: number
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
  request: CeremonyPreparationRequest,
  snapshot: PlanningSnapshot,
  stage: PreparationCacheIdentity['stage'],
  templateDigest?: Hash,
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
  ...(templateDigest ? { templateDigest } : {}),
  freshUntil: request.freshUntil,
})

export class TransactionCeremonyPreparationService {
  private readonly adoptionIdentities = new Map<Hash, PreparationCacheIdentity>()

  constructor(
    private readonly dependencies: CeremonyPreparationDependencies,
    private readonly cache: PreparationCache,
    private readonly generation: GenerationPublisher,
    private readonly now: () => number = Date.now,
  ) {}

  getAdoptionIdentity(ceremonyId: Hash): PreparationCacheIdentity | undefined {
    const identity = this.adoptionIdentities.get(ceremonyId)
    return identity ? { ...identity, accounts: [...identity.accounts], dataSourceVersions: { ...identity.dataSourceVersions } } : undefined
  }

  async prepare(request: CeremonyPreparationRequest): Promise<Readonly<SealedCeremony>> {
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
        assertCeremonyIntegrity(cached)
        if (cached.validity.cartGeneration !== request.cartGeneration || cached.validity.policyVersionDigest !== request.policyVersionDigest) throw new Error('Cached ceremony identity is incomplete')
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
    const [permit2Slots, migrationSignatureSlots, pythEvidence] = await Promise.all([
      this.dependencies.preparePermit2Slots(resolved, request.wallet, snapshot),
      this.dependencies.prepareMigrationSignatureSlots(resolved, request.wallet, snapshot),
      this.dependencies.collectPythEvidence(resolved, request.wallet, snapshot, prefetched),
    ])
    await assertContext()
    const fallbackOwner = { intentId: request.intents[0].intentId, intentRevision: request.intents[0].revision }
    const effectOwners = pluginOwnerMap(compiled.plan, resolved, compiled.effectOwners, fallbackOwner)
    const materialize = (policyEvidenceDigest: Hash) => materializePreparedPlan({
      intents: request.intents,
      plan: resolved,
      wallet: request.wallet,
      sdk: this.dependencies.materializationSdk,
      permit2Slots,
      migrationSignatureSlots,
      pythEvidence,
      effectOwners,
      before: request.before,
      after: request.after,
      directCallAllowlist: this.dependencies.directCallAllowlist,
      policyEvidenceDigest,
    })
    const preliminary = materialize(zeroHash)
    const policy = await this.dependencies.resolvePolicy(preliminary, snapshot)
    await assertContext()
    const template = materialize(policy.digest)
    const templateDigest = executionTemplateDigest(template)
    const adoptionIdentity = cacheIdentity(request, snapshot, 'sealed-ceremony', templateDigest)
    const cachedCeremony = this.cache.get(adoptionIdentity, this.now())
    if (cachedCeremony) {
      assertCeremonyIntegrity(cachedCeremony)
      if (cachedCeremony.templateDigest !== templateDigest
        || cachedCeremony.validity.cartGeneration !== request.cartGeneration
        || cachedCeremony.validity.planningSnapshotDigest !== snapshot.digest
        || cachedCeremony.validity.policyVersionDigest !== request.policyVersionDigest) {
        throw new Error('Cached ceremony identity is incomplete')
      }
      await assertContext()
      this.adoptionIdentities.set(cachedCeremony.ceremonyId, adoptionIdentity)
      return cachedCeremony
    }
    const simulationIdentity = cacheIdentity(request, snapshot, 'whole-cart-simulation', templateDigest)
    let simulation: SimulationCertificate
    const cachedSimulation = this.cache.get(simulationIdentity, this.now())
    if (cachedSimulation) {
      simulation = cachedSimulation as unknown as SimulationCertificate
      if (simulation.templateDigest !== templateDigest) throw new Error('Cached simulation belongs to another template')
    }
    else {
      const projection = await this.dependencies.simulate(resolved, template, snapshot, compiled.plan)
      await assertContext()
      simulation = buildSimulationCertificate({ template, templateDigest, projection, observedAt: this.now() })
      this.cache.put(simulationIdentity, toCanonicalValue(simulation))
    }
    if (!simulation.canExecute) throw new Error('Reviewed transaction cannot execute')

    const rawCanonical = toCanonicalValue(compiled.plan)
    const previewCanonical = toCanonicalValue(resolved)
    const plugins: SealedPluginEnvelope = {
      rawPlan: rawCanonical,
      previewPlan: previewCanonical,
      rawPlanDigest: canonicalDigest('plugin-raw-v1', rawCanonical),
      previewPlanDigest: canonicalDigest('plugin-preview-v1', previewCanonical),
      pluginConfigurationDigest: canonicalDigest('plugin-configuration-v1', this.dependencies.pluginConfiguration),
    }
    const ceremony = sealCeremony({
      intents: request.intents,
      template,
      policyEvidence: policy,
      simulation,
      plugins,
      validity: {
        createdAt: this.now(),
        expiresAt: request.freshUntil,
        cartGeneration: request.cartGeneration,
        planningSnapshotDigest: snapshot.digest,
        policyVersionDigest: request.policyVersionDigest,
      },
      presentationKind: request.presentationKind,
      presentationInputs: request.presentationInputs,
    })
    await assertContext()
    this.cache.put(adoptionIdentity, toCanonicalValue(ceremony))
    this.adoptionIdentities.set(ceremony.ceremonyId, adoptionIdentity)
    return ceremony
  }
}
