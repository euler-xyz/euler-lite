import type { Hash } from 'viem'
import { canonicalDigest, deepFreezeSerializable, toCanonicalValue, type CanonicalValue } from './canonical'
import type { CeremonyValidity, PolicyEvidenceBundle, SealedCeremony, SealedPluginEnvelope, SimulationCertificate } from './ceremony'
import type { OperationIntent } from './intents'
import { assertSealedCeremony } from './schemas'
import type { ExecutionTemplate } from './template'
import { validateExecutionTemplate } from './validators'
import { createOperationReviewBinding } from '../review/binding'
import { buildInternalManifest } from '../review/internal-manifest'
import { buildPolicyEvidence } from '../policy/engine'

export const sealCeremony = ({
  intents,
  template,
  policyEvidence,
  simulation,
  validity,
  plugins,
  presentationKind,
  presentationInputs,
}: {
  intents: readonly OperationIntent[]
  template: ExecutionTemplate
  policyEvidence: PolicyEvidenceBundle
  simulation: SimulationCertificate
  validity: CeremonyValidity
  plugins: SealedPluginEnvelope
  presentationKind: string
  presentationInputs: CanonicalValue
}): Readonly<SealedCeremony> => {
  validateExecutionTemplate(template, intents)
  const templateDigest = canonicalDigest('execution-template-v1', toCanonicalValue(template))
  if (template.policyEvidenceDigest !== policyEvidence.digest) throw new Error('Template policy digest does not match its evidence')
  if (simulation.templateDigest !== templateDigest) throw new Error('Simulation certificate belongs to another template')
  if (
    canonicalDigest('plugin-plan-content-v1', plugins.previewPlan)
    === canonicalDigest('plugin-plan-content-v1', plugins.rawPlan)
    && template.pythRefreshSlots.length
  ) {
    throw new Error('Pyth ceremony preview does not contain a processed plugin difference')
  }
  const ceremonyId = canonicalDigest('ceremony-id-v1', toCanonicalValue({
    templateDigest,
    intents: intents.map(intent => ({ intentId: intent.intentId, revision: intent.revision })),
    validity,
  }))
  const reviewBinding = createOperationReviewBinding({ ceremonyId, intents, presentationKind, presentationInputs })
  const internalManifest = buildInternalManifest(template, templateDigest)
  const consentDigest = canonicalDigest('ceremony-consent-v1', toCanonicalValue({
    ceremonyId,
    templateDigest,
    policyEvidenceDigest: policyEvidence.digest,
    simulationTemplateDigest: simulation.templateDigest,
    reviewPresentationDigest: reviewBinding.presentationDigest,
    pluginRawDigest: plugins.rawPlanDigest,
    pluginPreviewDigest: plugins.previewPlanDigest,
    pluginConfigurationDigest: plugins.pluginConfigurationDigest,
  }))
  const ceremony: SealedCeremony = {
    schemaVersion: 1,
    ceremonyId,
    templateDigest,
    consentDigest,
    intents: [...intents],
    template,
    policyEvidence,
    simulation,
    internalManifest,
    reviewBinding,
    validity,
    plugins,
  }
  assertCeremonyIntegrity(ceremony)
  return deepFreezeSerializable(ceremony) as Readonly<SealedCeremony>
}

export const digestPluginPlan = (schema: 'raw' | 'preview' | 'configuration', value: CanonicalValue): Hash =>
  canonicalDigest(`plugin-${schema}-v1`, value)

/**
 * Recomputes every derivable commitment after cache or journal retrieval.
 * Shape validation alone is insufficient because persisted records are an
 * untrusted serialization boundary.
 */
export function assertCeremonyIntegrity(value: unknown): asserts value is SealedCeremony {
  assertSealedCeremony(value)
  validateExecutionTemplate(value.template, value.intents)
  const templateDigest = canonicalDigest('execution-template-v1', toCanonicalValue(value.template))
  if (value.templateDigest !== templateDigest) throw new Error('Ceremony template digest is corrupt')
  if (value.simulation.templateDigest !== templateDigest) throw new Error('Ceremony simulation digest is corrupt')
  const rebuiltPolicy = buildPolicyEvidence({ template: value.template, evidence: value.policyEvidence.evidence, now: value.validity.createdAt })
  const policyDigest = rebuiltPolicy.digest
  if (canonicalDigest('policy-subjects-v1', toCanonicalValue(rebuiltPolicy.subjects)) !== canonicalDigest('policy-subjects-v1', toCanonicalValue(value.policyEvidence.subjects))) {
    throw new Error('Ceremony policy subjects are corrupt')
  }
  if (value.policyEvidence.digest !== policyDigest || value.template.policyEvidenceDigest !== policyDigest) {
    throw new Error('Ceremony policy evidence digest is corrupt')
  }
  if (value.plugins.rawPlanDigest !== digestPluginPlan('raw', value.plugins.rawPlan)) throw new Error('Ceremony raw plugin plan digest is corrupt')
  if (value.plugins.previewPlanDigest !== digestPluginPlan('preview', value.plugins.previewPlan)) throw new Error('Ceremony preview plugin plan digest is corrupt')
  if (
    canonicalDigest('plugin-plan-content-v1', value.plugins.previewPlan)
    === canonicalDigest('plugin-plan-content-v1', value.plugins.rawPlan)
    && value.template.pythRefreshSlots.length
  ) throw new Error('Pyth ceremony preview does not contain a processed plugin difference')

  const ceremonyId = canonicalDigest('ceremony-id-v1', toCanonicalValue({
    templateDigest,
    intents: value.intents.map(intent => ({ intentId: intent.intentId, revision: intent.revision })),
    validity: value.validity,
  }))
  if (value.ceremonyId !== ceremonyId) throw new Error('Ceremony ID is corrupt')
  if (value.reviewBinding.ceremonyId !== ceremonyId) throw new Error('Ceremony review binding is corrupt')
  const revisions = value.intents.map(intent => ({ intentId: intent.intentId, revision: intent.revision }))
  if (canonicalDigest('intent-revisions-v1', toCanonicalValue(value.reviewBinding.intentRevisions)) !== canonicalDigest('intent-revisions-v1', toCanonicalValue(revisions))) {
    throw new Error('Ceremony review intent revisions are corrupt')
  }
  const manifest = buildInternalManifest(value.template, templateDigest)
  if (canonicalDigest('ceremony-manifest-v1', toCanonicalValue(value.internalManifest)) !== canonicalDigest('ceremony-manifest-v1', toCanonicalValue(manifest))) {
    throw new Error('Ceremony internal manifest is corrupt')
  }
  const consentDigest = canonicalDigest('ceremony-consent-v1', toCanonicalValue({
    ceremonyId,
    templateDigest,
    policyEvidenceDigest: policyDigest,
    simulationTemplateDigest: value.simulation.templateDigest,
    reviewPresentationDigest: value.reviewBinding.presentationDigest,
    pluginRawDigest: value.plugins.rawPlanDigest,
    pluginPreviewDigest: value.plugins.previewPlanDigest,
    pluginConfigurationDigest: value.plugins.pluginConfigurationDigest,
  }))
  if (value.consentDigest !== consentDigest) throw new Error('Ceremony consent digest is corrupt')
}
