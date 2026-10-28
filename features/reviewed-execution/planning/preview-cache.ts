import { getAddress, type Address, type Hash } from 'viem'
import type { PlanMigrationSimulationResult, TransactionPlan, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { canonicalDigest, deepFreezeSerializable, toCanonicalValue, type CanonicalValue } from '../domain/canonical'
import type { OperationIntent } from '../domain/intents'
import { collectPlanningRequirements, intentSetDigest } from './requirements'

interface PreviewPluginCache {
  rawPlanDigest: Hash
  value: CanonicalValue
}

interface PreparedPreviewCache {
  rawPlanDigest: Hash
  preparedPlanDigest: Hash
  owner: Address
  chainId: number
  usePermit2: boolean
  unlimitedApproval: boolean
}

interface PreviewSimulationCache {
  preparedPlanDigest: Hash
  value: CanonicalValue
}

interface PreviewCacheRecord {
  schemaVersion: 1
  intentSetHash: Hash
  owner: Address
  chainId: number
  accounts: readonly Address[]
  rawPlanDigest: Hash
  observedAt: number
  freshUntil: number
  plugin?: PreviewPluginCache
  prepared?: PreparedPreviewCache
  simulation?: PreviewSimulationCache
}

export interface PreviewCacheHit {
  pluginPrefetch?: CanonicalValue
  simulationProjection?: CanonicalValue
}

const previewCache = new Map<Hash, Readonly<PreviewCacheRecord>>()
interface MigrationPreviewCacheRecord {
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

const migrationPreviewCache = new Map<Hash, Readonly<MigrationPreviewCacheRecord>>()
const PREVIEW_CACHE_TTL_MS = 60_000
const MAX_PREVIEW_CACHE_RECORDS = 256

const pruneRecords = <T extends { freshUntil: number }>(records: Map<Hash, Readonly<T>>, now: number) => {
  for (const [key, record] of records) {
    if (record.freshUntil <= now) records.delete(key)
  }
  while (records.size >= MAX_PREVIEW_CACHE_RECORDS) {
    const oldest = records.keys().next().value
    if (!oldest) break
    records.delete(oldest)
  }
}

const planDigest = (plan: TransactionPlan) =>
  canonicalDigest('preview-plan-v1', toCanonicalValue(plan))

const accountOwner = (account: TransactionPlanPrepared['account']): Address =>
  getAddress(typeof account === 'string' ? account : account.owner)

const updatePreviewCache = (
  key: Hash,
  update: (current: Readonly<PreviewCacheRecord>) => PreviewCacheRecord,
) => {
  const current = previewCache.get(key)
  if (!current) return
  previewCache.delete(key)
  previewCache.set(key, deepFreezeSerializable(update(current)) as Readonly<PreviewCacheRecord>)
}

/**
 * Publishes the digest of a page-owned preview under the explicit intent
 * set that produced it. This cache is an optimization only: execution
 * preparation recompiles from the DTOs and never adopts the mutable preview as
 * execution authority.
 */
export const cachePreviewPlan = (
  intents: readonly OperationIntent[],
  plan: TransactionPlan,
): void => {
  const requirements = collectPlanningRequirements(intents)
  const rawPlanDigest = planDigest(plan)
  const now = Date.now()
  const previous = previewCache.get(requirements.intentSetHash)
  pruneRecords(previewCache, now)
  previewCache.set(requirements.intentSetHash, deepFreezeSerializable({
    schemaVersion: 1,
    intentSetHash: requirements.intentSetHash,
    owner: requirements.owner,
    chainId: requirements.chainId,
    accounts: requirements.accounts,
    rawPlanDigest,
    observedAt: now,
    freshUntil: now + PREVIEW_CACHE_TTL_MS,
    ...(previous?.rawPlanDigest === rawPlanDigest && previous.freshUntil > now
      ? {
          ...(previous.plugin ? { plugin: previous.plugin } : {}),
          ...(previous.prepared ? { prepared: previous.prepared } : {}),
          ...(previous.simulation ? { simulation: previous.simulation } : {}),
        }
      : {}),
  }))
}

/**
 * Cache serializable form-time plugin inputs. Execution preparation still
 * recompiles the raw plan and matches its
 * digest before importing this value into the context-complete preparation
 * cache. Mutable SDK objects are deliberately never stored here.
 */
export const cachePreviewPluginData = (
  intents: readonly OperationIntent[],
  plan: TransactionPlan,
  value: CanonicalValue,
) => {
  cachePreviewPlan(intents, plan)
  const key = intentSetDigest(intents)
  const digest = planDigest(plan)
  updatePreviewCache(key, current => ({
    ...current,
    observedAt: Date.now(),
    freshUntil: Date.now() + PREVIEW_CACHE_TTL_MS,
    rawPlanDigest: digest,
    plugin: { rawPlanDigest: digest, value },
    ...(current.rawPlanDigest === digest
      ? {}
      : { prepared: undefined, simulation: undefined }),
  }))
}

/** Bind only canonical identity to a prepared SDK result; the mutable result is not cached. */
export const cachePreparedPreview = (
  intents: readonly OperationIntent[],
  rawPlan: TransactionPlan,
  prepared: TransactionPlanPrepared,
) => {
  cachePreviewPlan(intents, rawPlan)
  const key = intentSetDigest(intents)
  const rawPlanDigest = planDigest(rawPlan)
  const preparedPlanDigest = planDigest(prepared.plan)
  const preparedOwner = accountOwner(prepared.account)
  updatePreviewCache(key, current => ({
    ...current,
    observedAt: Date.now(),
    freshUntil: Date.now() + PREVIEW_CACHE_TTL_MS,
    rawPlanDigest,
    prepared: {
      rawPlanDigest,
      preparedPlanDigest,
      owner: preparedOwner,
      chainId: prepared.chainId,
      usePermit2: prepared.usePermit2,
      unlimitedApproval: prepared.unlimitedApproval,
    },
    simulation: current.prepared?.preparedPlanDigest === preparedPlanDigest
      && current.prepared.owner === preparedOwner
      && current.prepared.chainId === prepared.chainId
      && current.prepared.usePermit2 === prepared.usePermit2
      && current.prepared.unlimitedApproval === prepared.unlimitedApproval
      ? current.simulation
      : undefined,
  }))
}

/** Cache a plain simulation projection, never the mutable prepared result. */
export const cachePreviewSimulation = (
  intents: readonly OperationIntent[],
  prepared: TransactionPlanPrepared,
  projection: CanonicalValue,
) => {
  const key = intentSetDigest(intents)
  const preparedPlanDigest = planDigest(prepared.plan)
  const preparedOwner = accountOwner(prepared.account)
  updatePreviewCache(key, current => current.prepared?.preparedPlanDigest === preparedPlanDigest
    && current.prepared.owner === preparedOwner
    && current.prepared.chainId === prepared.chainId
    && current.prepared.usePermit2 === prepared.usePermit2
    && current.prepared.unlimitedApproval === prepared.unlimitedApproval
    ? {
        ...current,
        observedAt: Date.now(),
        freshUntil: Date.now() + PREVIEW_CACHE_TTL_MS,
        simulation: { preparedPlanDigest, value: projection },
      }
    : { ...current })
}

/**
 * Return only cached values whose intent, raw plan, wallet, approval mode, prepared
 * plan, and freshness all match the authoritative preparation in progress.
 */
export const readPreviewCache = ({
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
}): Readonly<PreviewCacheHit> => {
  const requirements = collectPlanningRequirements(intents)
  const record = previewCache.get(requirements.intentSetHash)
  if (record?.freshUntil !== undefined && record.freshUntil <= now) previewCache.delete(requirements.intentSetHash)
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
 * The mutable page result and SDK account never enter the preview cache.
 */
export const cacheMigrationPreview = (
  intent: OperationIntent,
  result: PlanMigrationSimulationResult,
  observedBlock: bigint,
  now = Date.now(),
) => {
  const requirements = collectPlanningRequirements([intent])
  pruneRecords(migrationPreviewCache, now)
  migrationPreviewCache.set(requirements.intentSetHash, deepFreezeSerializable({
    schemaVersion: 1,
    intentSetHash: requirements.intentSetHash,
    owner: requirements.owner,
    chainId: requirements.chainId,
    accounts: requirements.accounts,
    observedBlock,
    observedAt: now,
    freshUntil: now + PREVIEW_CACHE_TTL_MS,
    result: toCanonicalValue(result),
  }) as Readonly<MigrationPreviewCacheRecord>)
}

/** Adopt a migration compilation only at its exact intent/account/block identity. */
export const readMigrationPreviewCache = (
  intent: OperationIntent,
  observedBlock: bigint,
  now = Date.now(),
): PlanMigrationSimulationResult | undefined => {
  const requirements = collectPlanningRequirements([intent])
  const record = migrationPreviewCache.get(requirements.intentSetHash)
  if (record?.freshUntil !== undefined && record.freshUntil <= now) migrationPreviewCache.delete(requirements.intentSetHash)
  if (!record || record.freshUntil <= now
    || record.owner !== requirements.owner
    || record.chainId !== requirements.chainId
    || record.observedBlock !== observedBlock
    || record.accounts.length !== requirements.accounts.length
    || record.accounts.some((account, index) => account !== requirements.accounts[index])) return undefined
  return record.result as unknown as PlanMigrationSimulationResult
}

export const clearPreviewCacheForTests = () => {
  previewCache.clear()
  migrationPreviewCache.clear()
}
