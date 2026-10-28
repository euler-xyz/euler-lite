import type { Address, Hash } from 'viem'
import { canonicalDigest, deepFreezeSerializable, toCanonicalValue, type CanonicalValue } from '../domain/canonical'
import type { PlanningRequirements } from './requirements'
import type { GenerationPublisher, PreparationCache, PreparationCacheIdentity } from './cache'

export interface PlanningSnapshot {
  schemaVersion: 1
  intentSetHash: Hash
  owner: Address
  chainId: number
  observedBlock: bigint
  dataSourceVersions: Readonly<Record<string, string>>
  records: Readonly<Record<string, CanonicalValue>>
  digest: Hash
}

export interface SnapshotDependencyResult {
  value: CanonicalValue
  observedBlock: bigint
  version: string
  freshUntil: number
}

export interface SnapshotLoaderDependencies {
  /** Current source version used in cache identity before any read is issued. */
  version?: (key: string, requirements: PlanningRequirements) => string
  load(key: string, requirements: PlanningRequirements): Promise<SnapshotDependencyResult>
}

const requirementKeys = (requirements: PlanningRequirements) => [
  `account:${requirements.owner}`,
  ...requirements.accounts.map(value => `account:${value}`),
  ...requirements.vaults.map(value => `vault:${value}`),
  ...requirements.assets.map(value => `asset:${value}`),
  ...requirements.quotes.map(value => `quote:${value}`),
].filter((value, index, values) => values.indexOf(value) === index).sort()

export class PlanningSnapshotLoader {
  constructor(
    private readonly cache: PreparationCache,
    private readonly dependencies: SnapshotLoaderDependencies,
    private readonly generation: GenerationPublisher,
    private readonly compilerVersion: string,
  ) {}

  async load(requirements: PlanningRequirements, cartGeneration: number, now = Date.now()): Promise<Readonly<PlanningSnapshot>> {
    this.generation.assertCurrent(cartGeneration)
    const records: Record<string, CanonicalValue> = {}
    const versions: Record<string, string> = {}
    let observedBlock: bigint | undefined
    for (const key of requirementKeys(requirements)) {
      const expectedVersion = this.dependencies.version?.(key, requirements)
      const base: PreparationCacheIdentity = {
        schemaVersion: 1, stage: 'snapshot', intentSetHash: requirements.intentSetHash,
        cartGeneration, owner: requirements.owner, chainId: requirements.chainId,
        accounts: requirements.accounts, dataSourceVersions: {
          requirement: key,
          ...(expectedVersion === undefined ? {} : { source: expectedVersion }),
        },
        compilerVersion: this.compilerVersion,
      }
      const cached = this.cache.get(base, now)
      let result: SnapshotDependencyResult
      if (cached) result = cached as unknown as SnapshotDependencyResult
      else {
        result = await this.dependencies.load(key, requirements)
        this.generation.assertCurrent(cartGeneration)
        this.cache.put({ ...base, freshUntil: result.freshUntil }, toCanonicalValue(result))
      }
      this.generation.assertCurrent(cartGeneration)
      if (expectedVersion !== undefined && result.version !== expectedVersion) {
        throw new Error(`Planning snapshot source version changed for ${key}`)
      }
      if (observedBlock !== undefined && result.observedBlock !== observedBlock) {
        throw new Error('Planning snapshot dependencies do not share one observed block')
      }
      observedBlock = result.observedBlock
      records[key] = result.value
      versions[key] = result.version
    }
    if (observedBlock === undefined) throw new Error('Planning snapshot has no observed block')
    const body = { schemaVersion: 1 as const, intentSetHash: requirements.intentSetHash, owner: requirements.owner, chainId: requirements.chainId, observedBlock, dataSourceVersions: versions, records }
    const snapshot: PlanningSnapshot = { ...body, digest: canonicalDigest('planning-snapshot-v1', toCanonicalValue(body)) }
    return deepFreezeSerializable(snapshot) as Readonly<PlanningSnapshot>
  }
}
