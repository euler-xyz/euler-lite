import { getAddress, type Address, type Hash } from 'viem'
import type { PlanMigrationSimulationResult, TransactionPlan, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { canonicalDigest, deepFreezeSerializable, toCanonicalValue, type CanonicalValue } from '../domain/canonical'
import type { OperationIntent } from '../domain/intents'
import { collectPlanningRequirements, intentSetDigest } from './requirements'

const eagerPlanIntents = new WeakMap<TransactionPlan, readonly OperationIntent[]>()
const preparedOrigins = new WeakMap<TransactionPlanPrepared, Hash>()

interface EagerPluginEvidence {
  rawPlanDigest: Hash
  value: CanonicalValue
}

interface EagerPreparedEvidence {
  rawPlanDigest: Hash
  preparedPlanDigest: Hash
  owner: Address
  chainId: number
  usePermit2: boolean
  unlimitedApproval: boolean
}

interface EagerSimulationEvidence {
  preparedPlanDigest: Hash
  value: CanonicalValue
}

interface EagerAccelerationRecord {
  schemaVersion: 1
  intentSetHash: Hash
  owner: Address
  chainId: number
  accounts: readonly Address[]
  rawPlanDigest: Hash
  observedAt: number
  freshUntil: number
  plugin?: EagerPluginEvidence
  prepared?: EagerPreparedEvidence
  simulation?: EagerSimulationEvidence
}

export interface EagerAccelerationMatch {
  pluginPrefetch?: CanonicalValue
  simulationProjection?: CanonicalValue
}

const accelerations = new Map<Hash, Readonly<EagerAccelerationRecord>>()
interface EagerMigrationCompilationRecord {
  schemaVersion: 1
  intentSetHash: Hash
  owner: Address
  chainId: number
  accounts: readonly Address[]
  observedBlock: bigint
  observedAt: number
  freshUntil: number
  result: CanonicalValue
}

const migrationCompilations = new Map<Hash, Readonly<EagerMigrationCompilationRecord>>()
const EAGER_ACCELERATION_TTL_MS = 60_000

const planDigest = (plan: TransactionPlan) =>
  canonicalDigest('eager-plan-v1', toCanonicalValue(plan))

const accountOwner = (account: TransactionPlanPrepared['account']): Address =>
  getAddress(typeof account === 'string' ? account : account.owner)

const updateAcceleration = (
  key: Hash,
  update: (current: Readonly<EagerAccelerationRecord>) => EagerAccelerationRecord,
) => {
  const current = accelerations.get(key)
  if (!current) return
  accelerations.set(key, deepFreezeSerializable(update(current)) as Readonly<EagerAccelerationRecord>)
}

/**
 * Associates a page-owned eager preview with immutable intent DTOs. This is an
 * acceleration bridge only: ceremony preparation recompiles from the DTOs and
 * never adopts the mutable preview as execution authority.
 */
export const bindEagerPlanIntents = (
  plan: TransactionPlan,
  intents: readonly OperationIntent[],
): TransactionPlan => {
  const frozenIntents = Object.freeze([...intents])
  eagerPlanIntents.set(plan, frozenIntents)
  const requirements = collectPlanningRequirements(frozenIntents)
  const rawPlanDigest = planDigest(plan)
  const previous = accelerations.get(requirements.intentSetHash)
  const now = Date.now()
  accelerations.set(requirements.intentSetHash, deepFreezeSerializable({
    schemaVersion: 1,
    intentSetHash: requirements.intentSetHash,
    owner: requirements.owner,
    chainId: requirements.chainId,
    accounts: requirements.accounts,
    rawPlanDigest,
    observedAt: now,
    freshUntil: now + EAGER_ACCELERATION_TTL_MS,
    ...(previous?.rawPlanDigest === rawPlanDigest && previous.freshUntil > now
      ? {
          ...(previous.plugin ? { plugin: previous.plugin } : {}),
          ...(previous.prepared ? { prepared: previous.prepared } : {}),
          ...(previous.simulation ? { simulation: previous.simulation } : {}),
        }
      : {}),
  }))
  return plan
}

export const getEagerPlanIntents = (plan: TransactionPlan): readonly OperationIntent[] => {
  const intents = eagerPlanIntents.get(plan)
  if (!intents?.length) throw new Error('The eager preview is not bound to an operation intent')
  return intents
}

export const collectEagerPlanIntents = (plans: readonly TransactionPlan[]): readonly OperationIntent[] =>
  plans.flatMap(plan => getEagerPlanIntents(plan))

/**
 * Publish serializable form-time plugin inputs into the untrusted acceleration
 * bridge. Ceremony preparation still recompiles the raw plan and matches its
 * digest before importing this value into the context-complete preparation
 * cache. Mutable SDK objects are deliberately never stored here.
 */
export const publishEagerPluginPrefetch = (
  plan: TransactionPlan,
  value: CanonicalValue,
) => {
  const intents = eagerPlanIntents.get(plan)
  if (!intents?.length) return
  const key = intentSetDigest(intents)
  const digest = planDigest(plan)
  updateAcceleration(key, current => ({
    ...current,
    observedAt: Date.now(),
    freshUntil: Date.now() + EAGER_ACCELERATION_TTL_MS,
    rawPlanDigest: digest,
    plugin: { rawPlanDigest: digest, value },
    ...(current.rawPlanDigest === digest
      ? {}
      : { prepared: undefined, simulation: undefined }),
  }))
}

/** Bind only canonical identity to a prepared SDK envelope; the envelope is not cached. */
export const publishEagerPreparedPlan = (
  rawPlan: TransactionPlan,
  prepared: TransactionPlanPrepared,
) => {
  const intents = eagerPlanIntents.get(rawPlan)
  if (!intents?.length) return
  const key = intentSetDigest(intents)
  const rawPlanDigest = planDigest(rawPlan)
  const preparedPlanDigest = planDigest(prepared.plan)
  updateAcceleration(key, current => ({
    ...current,
    observedAt: Date.now(),
    freshUntil: Date.now() + EAGER_ACCELERATION_TTL_MS,
    rawPlanDigest,
    prepared: {
      rawPlanDigest,
      preparedPlanDigest,
      owner: accountOwner(prepared.account),
      chainId: prepared.chainId,
      usePermit2: prepared.usePermit2,
      unlimitedApproval: prepared.unlimitedApproval,
    },
    simulation: current.prepared?.preparedPlanDigest === preparedPlanDigest
      ? current.simulation
      : undefined,
  }))
  preparedOrigins.set(prepared, key)
}

/** Publish a plain simulation projection, never the mutable prepared envelope/result. */
export const publishEagerPreparedSimulation = (
  prepared: TransactionPlanPrepared,
  projection: CanonicalValue,
) => {
  const key = preparedOrigins.get(prepared)
  if (!key) return
  const preparedPlanDigest = planDigest(prepared.plan)
  updateAcceleration(key, current => ({
    ...current,
    observedAt: Date.now(),
    freshUntil: Date.now() + EAGER_ACCELERATION_TTL_MS,
    simulation: { preparedPlanDigest, value: projection },
  }))
}

/**
 * Return only evidence whose intent, raw plan, wallet, approval mode, prepared
 * plan, and freshness all match the authoritative preparation in progress.
 */
export const matchEagerAcceleration = ({
  intents,
  rawPlan,
  preparedPlan,
  owner,
  chainId,
  usePermit2,
  unlimitedApproval,
  allowSimulation,
  now = Date.now(),
}: {
  intents: readonly OperationIntent[]
  rawPlan: TransactionPlan
  preparedPlan?: TransactionPlan
  owner: Address
  chainId: number
  usePermit2: boolean
  unlimitedApproval: boolean
  allowSimulation: boolean
  now?: number
}): Readonly<EagerAccelerationMatch> => {
  const requirements = collectPlanningRequirements(intents)
  const record = accelerations.get(requirements.intentSetHash)
  if (!record || record.freshUntil <= now
    || record.owner !== getAddress(owner)
    || record.chainId !== chainId
    || record.accounts.length !== requirements.accounts.length
    || record.accounts.some((account, index) => account !== requirements.accounts[index])) return {}
  const rawPlanDigest = planDigest(rawPlan)
  if (record.rawPlanDigest !== rawPlanDigest) return {}
  const pluginPrefetch = record.plugin?.rawPlanDigest === rawPlanDigest
    ? record.plugin.value
    : undefined
  if (!allowSimulation || !preparedPlan || !record.prepared || !record.simulation) {
    return pluginPrefetch === undefined ? {} : { pluginPrefetch }
  }
  const preparedPlanDigest = planDigest(preparedPlan)
  const prepared = record.prepared
  const simulationProjection = prepared.rawPlanDigest === rawPlanDigest
    && prepared.preparedPlanDigest === preparedPlanDigest
    && record.simulation.preparedPlanDigest === preparedPlanDigest
    && prepared.owner === getAddress(owner)
    && prepared.chainId === chainId
    && prepared.usePermit2 === usePermit2
    && prepared.unlimitedApproval === unlimitedApproval
    ? record.simulation.value
    : undefined
  return {
    ...(pluginPrefetch === undefined ? {} : { pluginPrefetch }),
    ...(simulationProjection === undefined ? {} : { simulationProjection }),
  }
}

/**
 * Publish only a canonical clone of an already-warmed migration compilation.
 * The mutable page result and SDK account never enter the ceremony cache.
 */
export const publishEagerMigrationCompilation = (
  intent: OperationIntent,
  result: PlanMigrationSimulationResult,
  observedBlock: bigint,
  now = Date.now(),
) => {
  const requirements = collectPlanningRequirements([intent])
  migrationCompilations.set(requirements.intentSetHash, deepFreezeSerializable({
    schemaVersion: 1,
    intentSetHash: requirements.intentSetHash,
    owner: requirements.owner,
    chainId: requirements.chainId,
    accounts: requirements.accounts,
    observedBlock,
    observedAt: now,
    freshUntil: now + EAGER_ACCELERATION_TTL_MS,
    result: toCanonicalValue(result),
  }) as Readonly<EagerMigrationCompilationRecord>)
}

/** Adopt a migration compilation only at its exact intent/account/block identity. */
export const matchEagerMigrationCompilation = (
  intent: OperationIntent,
  observedBlock: bigint,
  now = Date.now(),
): PlanMigrationSimulationResult | undefined => {
  const requirements = collectPlanningRequirements([intent])
  const record = migrationCompilations.get(requirements.intentSetHash)
  if (!record || record.freshUntil <= now
    || record.owner !== requirements.owner
    || record.chainId !== requirements.chainId
    || record.observedBlock !== observedBlock
    || record.accounts.length !== requirements.accounts.length
    || record.accounts.some((account, index) => account !== requirements.accounts[index])) return undefined
  return record.result as unknown as PlanMigrationSimulationResult
}

export const clearEagerAccelerationsForTests = () => {
  accelerations.clear()
  migrationCompilations.clear()
}
