import { getAddress, type Address, type Hash } from 'viem'
import { canonicalDigest, deepFreezeSerializable, toCanonicalValue, type CanonicalValue } from '../domain/canonical'

export type PreparationStage = 'requirements' | 'snapshot' | 'plugins' | 'slot-hints' | 'quotes' | 'gas' | 'compiled-template' | 'whole-cart-simulation' | 'sealed-ceremony'

export interface PreparationCacheIdentity {
  schemaVersion: 1
  stage: PreparationStage
  intentSetHash: Hash
  cartGeneration: number
  owner: Address
  chainId: number
  accounts: readonly Address[]
  connectorId?: string
  connectorSessionId?: string
  observedBlock?: bigint
  dataSourceVersions: Readonly<Record<string, string>>
  compilerVersion: string
  policyVersionDigest?: Hash
  templateDigest?: Hash
  presentationDigest?: Hash
  freshUntil?: number
}

interface PreparationCacheRecord {
  identity: Readonly<PreparationCacheIdentity>
  value: CanonicalValue
}

const normalizedIdentity = (identity: PreparationCacheIdentity): PreparationCacheIdentity => ({
  ...identity,
  owner: getAddress(identity.owner),
  accounts: identity.accounts.map(getAddress),
  dataSourceVersions: Object.fromEntries(Object.entries(identity.dataSourceVersions).sort(([left], [right]) => left.localeCompare(right))),
})

export const preparationCacheKey = (identity: PreparationCacheIdentity): Hash =>
  canonicalDigest('preparation-cache-identity-v1', toCanonicalValue((({ freshUntil: _freshUntil, ...key }) => key)(normalizedIdentity(identity))))

export class PreparationCache {
  private readonly records = new Map<Hash, PreparationCacheRecord>()

  put(identity: PreparationCacheIdentity, value: CanonicalValue) {
    const normalized = normalizedIdentity(identity)
    const key = preparationCacheKey(normalized)
    this.records.set(key, {
      identity: deepFreezeSerializable(normalized) as Readonly<PreparationCacheIdentity>,
      value: deepFreezeSerializable(value) as CanonicalValue,
    })
  }

  get(identity: PreparationCacheIdentity, now = Date.now()): CanonicalValue | undefined {
    const record = this.records.get(preparationCacheKey(identity))
    if (!record) return undefined
    if (record.identity.freshUntil !== undefined && record.identity.freshUntil <= now) return undefined
    return record.value
  }

  deleteGeneration(owner: Address, chainId: number, generation: number) {
    const normalizedOwner = getAddress(owner)
    for (const [key, record] of this.records) {
      if (record.identity.owner === normalizedOwner && record.identity.chainId === chainId && record.identity.cartGeneration === generation) {
        this.records.delete(key)
      }
    }
  }

  clear() {
    this.records.clear()
  }
}

export class GenerationPublisher {
  private generation = 0

  current() {
    return this.generation
  }

  advance() {
    return ++this.generation
  }

  assertCurrent(generation: number) {
    if (generation !== this.generation) throw new Error('Preparation result belongs to a superseded generation')
  }
}
