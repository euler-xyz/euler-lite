import type { Hash } from 'viem'
import { canonicalDigest, deepFreezeSerializable, toCanonicalValue, type CanonicalValue } from './canonical'
import type { ReviewValidity, ReviewedPolicy, ReviewedExecution, PluginSnapshot, ReviewedRequestSet, ReviewedSimulation } from './reviewed-execution'
import type { OperationIntent } from './intents'
import { assertReviewedExecution } from './schemas'
import { validateReviewedRequestSet } from './validators'
import { createReviewBinding } from '../review/binding'
import { buildEffectMap } from '../review/effect-map'
import { buildReviewedPolicy } from '../policy/engine'

export const sealReviewedExecution = ({
  intents,
  requestSet,
  policy,
  simulation,
  validity,
  pluginSnapshot,
  presentationKind,
  presentationInputs,
}: {
  intents: readonly OperationIntent[]
  requestSet: ReviewedRequestSet
  policy: ReviewedPolicy
  simulation: ReviewedSimulation
  validity: ReviewValidity
  pluginSnapshot: PluginSnapshot
  presentationKind: string
  presentationInputs: CanonicalValue
}): Readonly<ReviewedExecution> => {
  validateReviewedRequestSet(requestSet, intents)
  const requestDigest = canonicalDigest('reviewed-request-set-v1', toCanonicalValue(requestSet))
  if (requestSet.policyDigest !== policy.digest) throw new Error('Request-set policy digest does not match its policy')
  if (simulation.requestDigest !== requestDigest) throw new Error('Simulation belongs to another request set')
  if (
    canonicalDigest('plugin-plan-content-v1', pluginSnapshot.previewPlan)
    === canonicalDigest('plugin-plan-content-v1', pluginSnapshot.rawPlan)
    && requestSet.pythRefreshSlots.length
  ) {
    throw new Error('Pyth preview does not contain a processed plugin difference')
  }
  const reviewId = canonicalDigest('reviewed-execution-id-v1', toCanonicalValue({
    requestDigest,
    intents: intents.map(intent => ({ intentId: intent.intentId, revision: intent.revision })),
    validity,
  }))
  const binding = createReviewBinding({ reviewId, intents, presentationKind, presentationInputs })
  const effectMap = buildEffectMap(requestSet, requestDigest)
  const reviewDigest = canonicalDigest('reviewed-execution-review-v1', toCanonicalValue({
    reviewId,
    requestDigest,
    policyDigest: policy.digest,
    simulationRequestDigest: simulation.requestDigest,
    reviewPresentationDigest: binding.presentationDigest,
    pluginRawDigest: pluginSnapshot.rawPlanDigest,
    pluginPreviewDigest: pluginSnapshot.previewPlanDigest,
    pluginConfigurationDigest: pluginSnapshot.pluginConfigurationDigest,
  }))
  const execution: ReviewedExecution = {
    schemaVersion: 1,
    reviewId,
    requestDigest,
    reviewDigest,
    intents: [...intents],
    requestSet,
    policy,
    simulation,
    effectMap,
    binding,
    validity,
    pluginSnapshot,
  }
  assertReviewedExecutionIntegrity(execution)
  return deepFreezeSerializable(execution) as Readonly<ReviewedExecution>
}

export const digestPluginPlan = (schema: 'raw' | 'preview' | 'configuration', value: CanonicalValue): Hash =>
  canonicalDigest(`plugin-${schema}-v1`, value)

/**
 * Recomputes every derivable commitment before an in-memory reviewed
 * execution reaches the wallet boundary. Shape validation alone is
 * insufficient because cached preparation data is not execution authority.
 */
export function assertReviewedExecutionIntegrity(value: unknown): asserts value is ReviewedExecution {
  assertReviewedExecution(value)
  validateReviewedRequestSet(value.requestSet, value.intents)
  const requestDigest = canonicalDigest('reviewed-request-set-v1', toCanonicalValue(value.requestSet))
  if (value.requestDigest !== requestDigest) throw new Error('Reviewed request-set digest is corrupt')
  if (value.simulation.requestDigest !== requestDigest) throw new Error('Execution simulation digest is corrupt')
  const rebuiltPolicy = buildReviewedPolicy({ requestSet: value.requestSet, results: value.policy.results, now: value.validity.createdAt })
  const policyDigest = rebuiltPolicy.digest
  if (canonicalDigest('policy-subjects-v1', toCanonicalValue(rebuiltPolicy.subjects)) !== canonicalDigest('policy-subjects-v1', toCanonicalValue(value.policy.subjects))) {
    throw new Error('Execution policy subjects are corrupt')
  }
  if (value.policy.digest !== policyDigest || value.requestSet.policyDigest !== policyDigest) {
    throw new Error('Execution policy result digest is corrupt')
  }
  if (value.pluginSnapshot.rawPlanDigest !== digestPluginPlan('raw', value.pluginSnapshot.rawPlan)) throw new Error('Reviewed execution raw plugin plan digest is corrupt')
  if (value.pluginSnapshot.previewPlanDigest !== digestPluginPlan('preview', value.pluginSnapshot.previewPlan)) throw new Error('Reviewed execution preview plugin plan digest is corrupt')
  if (
    canonicalDigest('plugin-plan-content-v1', value.pluginSnapshot.previewPlan)
    === canonicalDigest('plugin-plan-content-v1', value.pluginSnapshot.rawPlan)
    && value.requestSet.pythRefreshSlots.length
  ) throw new Error('Pyth preview does not contain a processed plugin difference')

  const reviewId = canonicalDigest('reviewed-execution-id-v1', toCanonicalValue({
    requestDigest,
    intents: value.intents.map(intent => ({ intentId: intent.intentId, revision: intent.revision })),
    validity: value.validity,
  }))
  if (value.reviewId !== reviewId) throw new Error('Execution ID is corrupt')
  if (value.binding.reviewId !== reviewId) throw new Error('Execution review binding is corrupt')
  const revisions = value.intents.map(intent => ({ intentId: intent.intentId, revision: intent.revision }))
  if (canonicalDigest('intent-revisions-v1', toCanonicalValue(value.binding.intentRevisions)) !== canonicalDigest('intent-revisions-v1', toCanonicalValue(revisions))) {
    throw new Error('Execution review intent revisions are corrupt')
  }
  const effectMap = buildEffectMap(value.requestSet, requestDigest)
  if (canonicalDigest('reviewed-execution-effect-map-v1', toCanonicalValue(value.effectMap)) !== canonicalDigest('reviewed-execution-effect-map-v1', toCanonicalValue(effectMap))) {
    throw new Error('Execution effect map is corrupt')
  }
  const reviewDigest = canonicalDigest('reviewed-execution-review-v1', toCanonicalValue({
    reviewId,
    requestDigest,
    policyDigest: policyDigest,
    simulationRequestDigest: value.simulation.requestDigest,
    reviewPresentationDigest: value.binding.presentationDigest,
    pluginRawDigest: value.pluginSnapshot.rawPlanDigest,
    pluginPreviewDigest: value.pluginSnapshot.previewPlanDigest,
    pluginConfigurationDigest: value.pluginSnapshot.pluginConfigurationDigest,
  }))
  if (value.reviewDigest !== reviewDigest) throw new Error('Execution review digest is corrupt')
}
