import type { Hash } from 'viem'
import { canonicalDigest, deepFreezeSerializable, toCanonicalValue, type CanonicalValue } from '../domain/canonical'
import type { AttemptRecord, AttemptState } from '../domain/attempt'
import type { SealedCeremony } from '../domain/ceremony'
import { assertCeremonyIntegrity } from '../domain/seal'
import { assertAttemptTransition } from '../coordinator/state-machine'

export const CEREMONY_JOURNAL_DB_NAME = 'euler-lite-transaction-ceremony'
export const CEREMONY_JOURNAL_DB_VERSION = 1
export const CEREMONY_JOURNAL_CHANNEL = 'euler-lite-transaction-ceremony'

const notifyJournalChanged = () => {
  if (typeof globalThis.BroadcastChannel !== 'function') return
  const channel = new BroadcastChannel(CEREMONY_JOURNAL_CHANNEL)
  channel.postMessage({ type: 'journal-changed' })
  channel.close()
}

const TERMINAL_STATES = new Set<AttemptState>([
  'succeeded',
  'safely-rejected-before-dispatch',
  'reverted',
  'cancelled-proven',
  'expired',
])

export const isTerminalAttemptState = (state: AttemptState) => TERMINAL_STATES.has(state)

export interface WalletLaneRecord {
  schemaVersion: 1
  laneKey: string
  account: `0x${string}`
  chainId: number
  attemptId: string
  reservationId: string
  ceremonyId: Hash
  templateDigest: Hash
  requestVectorDigest: Hash
  fence: number
  version: number
  reservedAt: number
  updatedAt: number
  releasedAt?: number
}

export interface AttemptEventRecord {
  schemaVersion: 1
  eventId: Hash
  attemptId: string
  sequence: number
  from?: AttemptState
  to: AttemptState
  at: number
  detail?: CanonicalValue
}

export interface ExternalArtifactRecord {
  schemaVersion: 1
  artifactId: Hash
  attemptId: string
  kind: 'transaction-hash' | 'calls-id' | 'execution-hash'
  value: string
  observedAt: number
}

export interface CleanupObligationRecord {
  schemaVersion: 1
  obligationId: Hash
  attemptId: string
  effectId: Hash
  status: 'pending' | 'completed' | 'failed'
  request: CanonicalValue
  createdAt: number
  updatedAt: number
  error?: string
}

export interface ReservationExpectation {
  attemptId: string
  reservationId: string
  ceremonyId: Hash
  templateDigest: Hash
  account: `0x${string}`
  chainId: number
  laneKey: string
  requestVectorDigest: Hash
  version?: number
  fence?: number
}

export interface ReserveAttemptInput {
  ceremony: SealedCeremony
  attemptId: string
  reservationId: string
  laneKey: string
  requestVectorDigest: Hash
  now: number
}

export interface AttemptCas {
  attemptId: string
  version: number
  fence: number
}

export interface TransitionAttemptInput {
  expected: AttemptCas
  to: AttemptState
  now: number
  stepIndex?: number
  error?: string
  detail?: CanonicalValue
}

export interface CeremonyJournal {
  putCeremony(ceremony: SealedCeremony): Promise<void>
  getCeremony(ceremonyId: Hash): Promise<SealedCeremony | undefined>
  reserveAttempt(input: ReserveAttemptInput): Promise<AttemptRecord>
  verifyReservation(expected: ReservationExpectation): Promise<AttemptRecord>
  transitionAttempt(input: TransitionAttemptInput): Promise<AttemptRecord>
  recordExternalArtifact(expected: AttemptCas, artifact: Omit<ExternalArtifactRecord, 'schemaVersion' | 'artifactId' | 'attemptId'>): Promise<AttemptRecord>
  putCleanupObligation(expected: AttemptCas, obligation: CleanupObligationRecord): Promise<void>
  updateCleanupObligation(expected: AttemptCas, obligationId: Hash, status: CleanupObligationRecord['status'], now: number, error?: string): Promise<void>
  releaseLane(expected: AttemptCas, now: number): Promise<void>
  getAttempt(attemptId: string): Promise<AttemptRecord | undefined>
  listRecoverableAttempts(): Promise<AttemptRecord[]>
  listAttemptEvents(attemptId: string): Promise<AttemptEventRecord[]>
  listExternalArtifacts(attemptId: string): Promise<ExternalArtifactRecord[]>
  listCleanupObligations(attemptId: string): Promise<CleanupObligationRecord[]>
}

const clone = <T>(value: T): T => deepFreezeSerializable(value) as T

const requestDigestFor = (ceremony: SealedCeremony): Hash =>
  canonicalDigest('journal-request-vector-v1', toCanonicalValue(ceremony.template.requests))

const eventFor = (
  attempt: AttemptRecord,
  from: AttemptState | undefined,
  to: AttemptState,
  at: number,
  detail?: CanonicalValue,
): AttemptEventRecord => ({
  schemaVersion: 1,
  eventId: canonicalDigest('attempt-event-v1', toCanonicalValue({ attemptId: attempt.attemptId, sequence: attempt.version, from, to, at, detail })),
  attemptId: attempt.attemptId,
  sequence: attempt.version,
  from,
  to,
  at,
  ...(detail === undefined ? {} : { detail }),
})

const assertCas = (attempt: AttemptRecord | undefined, expected: AttemptCas): AttemptRecord => {
  if (!attempt) throw new Error('Attempt record is missing')
  if (attempt.version !== expected.version || attempt.fence !== expected.fence) {
    throw new Error('Attempt compare-and-swap failed')
  }
  return attempt
}

const assertLaneMatchesAttempt = (lane: WalletLaneRecord | undefined, attempt: AttemptRecord): WalletLaneRecord => {
  if (!lane
    || lane.releasedAt !== undefined
    || lane.attemptId !== attempt.attemptId
    || lane.reservationId !== attempt.reservationId
    || lane.ceremonyId !== attempt.ceremonyId
    || lane.templateDigest !== attempt.templateDigest
    || lane.account.toLowerCase() !== attempt.account.toLowerCase()
    || lane.chainId !== attempt.chainId
    || lane.fence !== attempt.fence
    || lane.version !== attempt.version) {
    throw new Error('Wallet lane does not match the attempt version and fence')
  }
  return lane
}

const appendExternalId = (attempt: AttemptRecord, kind: ExternalArtifactRecord['kind'], value: string): AttemptRecord['externalIds'] => {
  if (attempt.externalIds.some(candidate => candidate.kind === kind && candidate.value.toLowerCase() === value.toLowerCase())) {
    return attempt.externalIds
  }
  return [...attempt.externalIds, { kind, value }]
}

/** Explicit deterministic test double. It is never selected by production code. */
export class MemoryCeremonyJournal implements CeremonyJournal {
  private ceremonies = new Map<Hash, SealedCeremony>()
  private attempts = new Map<string, AttemptRecord>()
  private lanes = new Map<string, WalletLaneRecord>()
  private events = new Map<string, AttemptEventRecord[]>()
  private artifacts = new Map<string, ExternalArtifactRecord[]>()
  private obligations = new Map<Hash, CleanupObligationRecord>()

  async putCeremony(ceremony: SealedCeremony) {
    assertCeremonyIntegrity(ceremony)
    const existing = this.ceremonies.get(ceremony.ceremonyId)
    if (existing && existing.consentDigest !== ceremony.consentDigest) throw new Error('Ceremony ID collision')
    this.ceremonies.set(ceremony.ceremonyId, clone(ceremony))
  }

  async getCeremony(ceremonyId: Hash) {
    const value = this.ceremonies.get(ceremonyId)
    if (!value) return undefined
    assertCeremonyIntegrity(value)
    return clone(value)
  }

  async reserveAttempt(input: ReserveAttemptInput): Promise<AttemptRecord> {
    if (input.requestVectorDigest !== requestDigestFor(input.ceremony)) throw new Error('Reservation request digest is incorrect')
    const durableCeremony = this.ceremonies.get(input.ceremony.ceremonyId)
    if (!durableCeremony) throw new Error('Ceremony must be durable before reservation')
    assertCeremonyIntegrity(durableCeremony)
    if (durableCeremony.consentDigest !== input.ceremony.consentDigest) throw new Error('Durable ceremony differs from the reservation input')
    if (this.attempts.has(input.attemptId)) throw new Error('Attempt already exists')
    const existingLane = this.lanes.get(input.laneKey)
    if (existingLane && existingLane.releasedAt === undefined) throw new Error('Wallet lane is already reserved')
    const fence = (existingLane?.fence ?? 0) + 1
    const wallet = input.ceremony.template.wallet
    const attempt: AttemptRecord = {
      schemaVersion: 1,
      attemptId: input.attemptId,
      ceremonyId: input.ceremony.ceremonyId,
      templateDigest: input.ceremony.templateDigest,
      state: 'reserved',
      account: wallet.account,
      chainId: wallet.chainId,
      laneKey: input.laneKey,
      reservationId: input.reservationId,
      version: 1,
      fence,
      stepIndex: 0,
      createdAt: input.now,
      updatedAt: input.now,
      externalIds: [],
    }
    const lane: WalletLaneRecord = {
      schemaVersion: 1,
      laneKey: input.laneKey,
      account: wallet.account,
      chainId: wallet.chainId,
      attemptId: input.attemptId,
      reservationId: input.reservationId,
      ceremonyId: input.ceremony.ceremonyId,
      templateDigest: input.ceremony.templateDigest,
      requestVectorDigest: input.requestVectorDigest,
      fence,
      version: 1,
      reservedAt: input.now,
      updatedAt: input.now,
    }
    this.attempts.set(attempt.attemptId, clone(attempt))
    this.lanes.set(lane.laneKey, clone(lane))
    this.events.set(attempt.attemptId, [clone(eventFor(attempt, undefined, 'reserved', input.now))])
    return clone(attempt)
  }

  async verifyReservation(expected: ReservationExpectation): Promise<AttemptRecord> {
    const attempt = this.attempts.get(expected.attemptId)
    const lane = this.lanes.get(expected.laneKey)
    if (!attempt || !lane || lane.releasedAt !== undefined) throw new Error('Durable reservation is missing')
    const checks = [
      attempt.reservationId === expected.reservationId,
      attempt.ceremonyId === expected.ceremonyId,
      attempt.templateDigest === expected.templateDigest,
      attempt.account.toLowerCase() === expected.account.toLowerCase(),
      attempt.chainId === expected.chainId,
      attempt.laneKey === expected.laneKey,
      lane.attemptId === expected.attemptId,
      lane.reservationId === expected.reservationId,
      lane.ceremonyId === expected.ceremonyId,
      lane.templateDigest === expected.templateDigest,
      lane.requestVectorDigest === expected.requestVectorDigest,
      lane.account.toLowerCase() === expected.account.toLowerCase(),
      lane.chainId === expected.chainId,
      lane.fence === attempt.fence,
      lane.version === attempt.version,
      expected.version === undefined || attempt.version === expected.version,
      expected.fence === undefined || attempt.fence === expected.fence,
    ]
    if (checks.some(check => !check)) throw new Error('Durable reservation does not match the ceremony')
    return clone(attempt)
  }

  async transitionAttempt(input: TransitionAttemptInput): Promise<AttemptRecord> {
    const current = assertCas(this.attempts.get(input.expected.attemptId), input.expected)
    const lane = assertLaneMatchesAttempt(this.lanes.get(current.laneKey), current)
    assertAttemptTransition(current.state, input.to)
    const next: AttemptRecord = clone({
      ...current,
      state: input.to,
      version: current.version + 1,
      updatedAt: input.now,
      stepIndex: input.stepIndex ?? current.stepIndex,
      ...(input.error === undefined ? {} : { error: input.error }),
    })
    this.attempts.set(next.attemptId, next)
    this.events.set(next.attemptId, [...(this.events.get(next.attemptId) ?? []), clone(eventFor(next, current.state, input.to, input.now, input.detail))])
    this.lanes.set(next.laneKey, clone({ ...lane, version: next.version, updatedAt: input.now }))
    return clone(next)
  }

  async recordExternalArtifact(expected: AttemptCas, artifact: Omit<ExternalArtifactRecord, 'schemaVersion' | 'artifactId' | 'attemptId'>): Promise<AttemptRecord> {
    const current = assertCas(this.attempts.get(expected.attemptId), expected)
    const lane = assertLaneMatchesAttempt(this.lanes.get(current.laneKey), current)
    assertAttemptTransition(current.state, 'identified')
    const artifactId = canonicalDigest('external-artifact-v1', toCanonicalValue({ attemptId: current.attemptId, kind: artifact.kind, value: artifact.value }))
    const records = this.artifacts.get(current.attemptId) ?? []
    if (!records.some(record => record.artifactId === artifactId)) {
      this.artifacts.set(current.attemptId, [...records, clone({ schemaVersion: 1, artifactId, attemptId: current.attemptId, ...artifact })])
    }
    const next: AttemptRecord = clone({
      ...current,
      state: 'identified',
      externalIds: appendExternalId(current, artifact.kind, artifact.value),
      version: current.version + 1,
      updatedAt: artifact.observedAt,
    })
    this.attempts.set(next.attemptId, next)
    this.events.set(next.attemptId, [...(this.events.get(next.attemptId) ?? []), clone(eventFor(next, current.state, 'identified', artifact.observedAt, { kind: artifact.kind, value: artifact.value }))])
    this.lanes.set(next.laneKey, clone({ ...lane, version: next.version, updatedAt: artifact.observedAt }))
    return clone(next)
  }

  async putCleanupObligation(expected: AttemptCas, obligation: CleanupObligationRecord) {
    const attempt = assertCas(this.attempts.get(expected.attemptId), expected)
    assertLaneMatchesAttempt(this.lanes.get(attempt.laneKey), attempt)
    if (obligation.attemptId !== expected.attemptId) throw new Error('Cleanup obligation belongs to another attempt')
    this.obligations.set(obligation.obligationId, clone(obligation))
  }

  async updateCleanupObligation(expected: AttemptCas, obligationId: Hash, status: CleanupObligationRecord['status'], now: number, error?: string) {
    const attempt = assertCas(this.attempts.get(expected.attemptId), expected)
    assertLaneMatchesAttempt(this.lanes.get(attempt.laneKey), attempt)
    const obligation = this.obligations.get(obligationId)
    if (!obligation || obligation.attemptId !== expected.attemptId) throw new Error('Cleanup obligation is missing')
    this.obligations.set(obligationId, clone({ ...obligation, status, updatedAt: now, ...(error === undefined ? {} : { error }) }))
  }

  async releaseLane(expected: AttemptCas, now: number) {
    const attempt = assertCas(this.attempts.get(expected.attemptId), expected)
    if (!isTerminalAttemptState(attempt.state)) throw new Error('Cannot release a non-terminal wallet lane')
    const lane = assertLaneMatchesAttempt(this.lanes.get(attempt.laneKey), attempt)
    this.lanes.set(lane.laneKey, clone({ ...lane, releasedAt: now, updatedAt: now }))
  }

  async getAttempt(attemptId: string) {
    const value = this.attempts.get(attemptId)
    return value ? clone(value) : undefined
  }

  async listRecoverableAttempts() {
    return [...this.attempts.values()].filter(attempt => !isTerminalAttemptState(attempt.state)).map(clone)
  }

  async listAttemptEvents(attemptId: string) {
    return (this.events.get(attemptId) ?? []).map(clone).sort((a, b) => a.sequence - b.sequence)
  }

  async listExternalArtifacts(attemptId: string) {
    return (this.artifacts.get(attemptId) ?? []).map(clone)
  }

  async listCleanupObligations(attemptId: string) {
    return [...this.obligations.values()].filter(item => item.attemptId === attemptId).map(clone)
  }
}

const requestResult = <T>(request: IDBRequest<T>): Promise<T> => new Promise((resolve, reject) => {
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error ?? new Error('IndexedDB request failed'))
})

const transactionDone = (transaction: IDBTransaction): Promise<void> => new Promise((resolve, reject) => {
  transaction.oncomplete = () => resolve()
  transaction.onabort = () => reject(transaction.error ?? new Error('IndexedDB transaction aborted'))
  transaction.onerror = () => reject(transaction.error ?? new Error('IndexedDB transaction failed'))
})

const openJournalDatabase = (factory: IDBFactory): Promise<IDBDatabase> => new Promise((resolve, reject) => {
  const request = factory.open(CEREMONY_JOURNAL_DB_NAME, CEREMONY_JOURNAL_DB_VERSION)
  request.onupgradeneeded = () => {
    const db = request.result
    if (!db.objectStoreNames.contains('ceremonies')) db.createObjectStore('ceremonies', { keyPath: 'ceremonyId' })
    if (!db.objectStoreNames.contains('attempts')) {
      const store = db.createObjectStore('attempts', { keyPath: 'attemptId' })
      store.createIndex('laneKey', 'laneKey', { unique: false })
      store.createIndex('state', 'state', { unique: false })
    }
    if (!db.objectStoreNames.contains('lanes')) db.createObjectStore('lanes', { keyPath: 'laneKey' })
    if (!db.objectStoreNames.contains('events')) {
      const store = db.createObjectStore('events', { keyPath: 'eventId' })
      store.createIndex('attemptId', 'attemptId', { unique: false })
    }
    if (!db.objectStoreNames.contains('externalArtifacts')) {
      const store = db.createObjectStore('externalArtifacts', { keyPath: 'artifactId' })
      store.createIndex('attemptId', 'attemptId', { unique: false })
    }
    if (!db.objectStoreNames.contains('cleanupObligations')) {
      const store = db.createObjectStore('cleanupObligations', { keyPath: 'obligationId' })
      store.createIndex('attemptId', 'attemptId', { unique: false })
    }
  }
  request.onsuccess = () => resolve(request.result)
  request.onerror = () => reject(request.error ?? new Error('Unable to open the ceremony journal'))
  request.onblocked = () => reject(new Error('Ceremony journal migration is blocked by another tab'))
})

/** Authoritative browser journal. Every mutating method is one short read-write transaction. */
export class IndexedDbCeremonyJournal implements CeremonyJournal {
  private constructor(private readonly database: IDBDatabase) {}

  static async open(factory?: IDBFactory): Promise<IndexedDbCeremonyJournal> {
    const selected = factory ?? globalThis.indexedDB
    if (!selected) throw new Error('IndexedDB is required for transaction execution')
    return new IndexedDbCeremonyJournal(await openJournalDatabase(selected))
  }

  async putCeremony(ceremony: SealedCeremony) {
    assertCeremonyIntegrity(ceremony)
    const tx = this.database.transaction('ceremonies', 'readwrite')
    const store = tx.objectStore('ceremonies')
    const existing = await requestResult(store.get(ceremony.ceremonyId)) as SealedCeremony | undefined
    if (existing && existing.consentDigest !== ceremony.consentDigest) {
      tx.abort()
      throw new Error('Ceremony ID collision')
    }
    store.put(ceremony)
    await transactionDone(tx)
    notifyJournalChanged()
  }

  async getCeremony(ceremonyId: Hash) {
    const tx = this.database.transaction('ceremonies', 'readonly')
    const value = await requestResult(tx.objectStore('ceremonies').get(ceremonyId)) as SealedCeremony | undefined
    await transactionDone(tx)
    if (value) assertCeremonyIntegrity(value)
    return value
  }

  async reserveAttempt(input: ReserveAttemptInput): Promise<AttemptRecord> {
    if (input.requestVectorDigest !== requestDigestFor(input.ceremony)) throw new Error('Reservation request digest is incorrect')
    const tx = this.database.transaction(['ceremonies', 'attempts', 'lanes', 'events'], 'readwrite')
    const ceremonies = tx.objectStore('ceremonies')
    const attempts = tx.objectStore('attempts')
    const lanes = tx.objectStore('lanes')
    const durableCeremony = await requestResult(ceremonies.get(input.ceremony.ceremonyId)) as SealedCeremony | undefined
    const existingAttempt = await requestResult(attempts.get(input.attemptId)) as AttemptRecord | undefined
    const existingLane = await requestResult(lanes.get(input.laneKey)) as WalletLaneRecord | undefined
    if (!durableCeremony || existingAttempt || (existingLane && existingLane.releasedAt === undefined)) {
      tx.abort()
      throw new Error(!durableCeremony ? 'Ceremony must be durable before reservation' : existingAttempt ? 'Attempt already exists' : 'Wallet lane is already reserved')
    }
    assertCeremonyIntegrity(durableCeremony)
    if (durableCeremony.consentDigest !== input.ceremony.consentDigest) {
      tx.abort()
      throw new Error('Durable ceremony differs from the reservation input')
    }
    const fence = (existingLane?.fence ?? 0) + 1
    const wallet = input.ceremony.template.wallet
    const attempt: AttemptRecord = {
      schemaVersion: 1, attemptId: input.attemptId, ceremonyId: input.ceremony.ceremonyId,
      templateDigest: input.ceremony.templateDigest, state: 'reserved', account: wallet.account,
      chainId: wallet.chainId, laneKey: input.laneKey, reservationId: input.reservationId,
      version: 1, fence, stepIndex: 0, createdAt: input.now, updatedAt: input.now, externalIds: [],
    }
    const lane: WalletLaneRecord = {
      schemaVersion: 1, laneKey: input.laneKey, account: wallet.account, chainId: wallet.chainId,
      attemptId: input.attemptId, reservationId: input.reservationId, ceremonyId: input.ceremony.ceremonyId,
      templateDigest: input.ceremony.templateDigest, requestVectorDigest: input.requestVectorDigest,
      fence, version: 1, reservedAt: input.now, updatedAt: input.now,
    }
    attempts.add(attempt)
    lanes.put(lane)
    tx.objectStore('events').add(eventFor(attempt, undefined, 'reserved', input.now))
    await transactionDone(tx)
    notifyJournalChanged()
    return attempt
  }

  async verifyReservation(expected: ReservationExpectation): Promise<AttemptRecord> {
    const tx = this.database.transaction(['attempts', 'lanes'], 'readonly')
    const attempt = await requestResult(tx.objectStore('attempts').get(expected.attemptId)) as AttemptRecord | undefined
    const lane = await requestResult(tx.objectStore('lanes').get(expected.laneKey)) as WalletLaneRecord | undefined
    await transactionDone(tx)
    if (!attempt || !lane || lane.releasedAt !== undefined) throw new Error('Durable reservation is missing')
    const matches = attempt.reservationId === expected.reservationId
      && attempt.ceremonyId === expected.ceremonyId
      && attempt.templateDigest === expected.templateDigest
      && attempt.account.toLowerCase() === expected.account.toLowerCase()
      && attempt.chainId === expected.chainId
      && attempt.laneKey === expected.laneKey
      && lane.attemptId === expected.attemptId
      && lane.reservationId === expected.reservationId
      && lane.ceremonyId === expected.ceremonyId
      && lane.templateDigest === expected.templateDigest
      && lane.requestVectorDigest === expected.requestVectorDigest
      && lane.account.toLowerCase() === expected.account.toLowerCase()
      && lane.chainId === expected.chainId
      && lane.fence === attempt.fence
      && lane.version === attempt.version
      && (expected.version === undefined || attempt.version === expected.version)
      && (expected.fence === undefined || attempt.fence === expected.fence)
    if (!matches) throw new Error('Durable reservation does not match the ceremony')
    return attempt
  }

  async transitionAttempt(input: TransitionAttemptInput): Promise<AttemptRecord> {
    const tx = this.database.transaction(['attempts', 'lanes', 'events'], 'readwrite')
    const attempts = tx.objectStore('attempts')
    const current = assertCas(await requestResult(attempts.get(input.expected.attemptId)) as AttemptRecord | undefined, input.expected)
    assertAttemptTransition(current.state, input.to)
    const next: AttemptRecord = {
      ...current, state: input.to, version: current.version + 1, updatedAt: input.now,
      stepIndex: input.stepIndex ?? current.stepIndex,
      ...(input.error === undefined ? {} : { error: input.error }),
    }
    const laneStore = tx.objectStore('lanes')
    const lane = await requestResult(laneStore.get(current.laneKey)) as WalletLaneRecord | undefined
    try {
      assertLaneMatchesAttempt(lane, current)
    }
    catch (error) {
      tx.abort()
      throw error
    }
    attempts.put(next)
    laneStore.put({ ...lane, version: next.version, updatedAt: input.now })
    tx.objectStore('events').add(eventFor(next, current.state, input.to, input.now, input.detail))
    await transactionDone(tx)
    notifyJournalChanged()
    return next
  }

  async recordExternalArtifact(expected: AttemptCas, artifact: Omit<ExternalArtifactRecord, 'schemaVersion' | 'artifactId' | 'attemptId'>): Promise<AttemptRecord> {
    const tx = this.database.transaction(['attempts', 'lanes', 'events', 'externalArtifacts'], 'readwrite')
    const attempts = tx.objectStore('attempts')
    const current = assertCas(await requestResult(attempts.get(expected.attemptId)) as AttemptRecord | undefined, expected)
    assertAttemptTransition(current.state, 'identified')
    const artifactId = canonicalDigest('external-artifact-v1', toCanonicalValue({ attemptId: current.attemptId, kind: artifact.kind, value: artifact.value }))
    const next: AttemptRecord = {
      ...current, state: 'identified', externalIds: appendExternalId(current, artifact.kind, artifact.value),
      version: current.version + 1, updatedAt: artifact.observedAt,
    }
    const laneStore = tx.objectStore('lanes')
    const lane = await requestResult(laneStore.get(current.laneKey)) as WalletLaneRecord | undefined
    try {
      assertLaneMatchesAttempt(lane, current)
    }
    catch (error) {
      tx.abort()
      throw error
    }
    tx.objectStore('externalArtifacts').put({ schemaVersion: 1, artifactId, attemptId: current.attemptId, ...artifact })
    attempts.put(next)
    laneStore.put({ ...lane, version: next.version, updatedAt: artifact.observedAt })
    tx.objectStore('events').add(eventFor(next, current.state, 'identified', artifact.observedAt, { kind: artifact.kind, value: artifact.value }))
    await transactionDone(tx)
    notifyJournalChanged()
    return next
  }

  async putCleanupObligation(expected: AttemptCas, obligation: CleanupObligationRecord) {
    const tx = this.database.transaction(['attempts', 'lanes', 'cleanupObligations'], 'readwrite')
    const attempt = assertCas(await requestResult(tx.objectStore('attempts').get(expected.attemptId)) as AttemptRecord | undefined, expected)
    assertLaneMatchesAttempt(await requestResult(tx.objectStore('lanes').get(attempt.laneKey)) as WalletLaneRecord | undefined, attempt)
    if (obligation.attemptId !== expected.attemptId) {
      tx.abort()
      throw new Error('Cleanup obligation belongs to another attempt')
    }
    tx.objectStore('cleanupObligations').put(obligation)
    await transactionDone(tx)
    notifyJournalChanged()
  }

  async updateCleanupObligation(expected: AttemptCas, obligationId: Hash, status: CleanupObligationRecord['status'], now: number, error?: string) {
    const tx = this.database.transaction(['attempts', 'lanes', 'cleanupObligations'], 'readwrite')
    const attempt = assertCas(await requestResult(tx.objectStore('attempts').get(expected.attemptId)) as AttemptRecord | undefined, expected)
    assertLaneMatchesAttempt(await requestResult(tx.objectStore('lanes').get(attempt.laneKey)) as WalletLaneRecord | undefined, attempt)
    const store = tx.objectStore('cleanupObligations')
    const obligation = await requestResult(store.get(obligationId)) as CleanupObligationRecord | undefined
    if (!obligation || obligation.attemptId !== expected.attemptId) {
      tx.abort()
      throw new Error('Cleanup obligation is missing')
    }
    store.put({ ...obligation, status, updatedAt: now, ...(error === undefined ? {} : { error }) })
    await transactionDone(tx)
    notifyJournalChanged()
  }

  async releaseLane(expected: AttemptCas, now: number) {
    const tx = this.database.transaction(['attempts', 'lanes'], 'readwrite')
    const attempt = assertCas(await requestResult(tx.objectStore('attempts').get(expected.attemptId)) as AttemptRecord | undefined, expected)
    if (!isTerminalAttemptState(attempt.state)) {
      tx.abort()
      throw new Error('Cannot release a non-terminal wallet lane')
    }
    const lanes = tx.objectStore('lanes')
    const lane = await requestResult(lanes.get(attempt.laneKey)) as WalletLaneRecord | undefined
    try {
      assertLaneMatchesAttempt(lane, attempt)
    }
    catch (error) {
      tx.abort()
      throw error
    }
    lanes.put({ ...lane, releasedAt: now, updatedAt: now })
    await transactionDone(tx)
    notifyJournalChanged()
  }

  async getAttempt(attemptId: string) {
    const tx = this.database.transaction('attempts', 'readonly')
    const value = await requestResult(tx.objectStore('attempts').get(attemptId)) as AttemptRecord | undefined
    await transactionDone(tx)
    return value
  }

  private async listByAttempt<T>(storeName: 'events' | 'externalArtifacts' | 'cleanupObligations', attemptId: string): Promise<T[]> {
    const tx = this.database.transaction(storeName, 'readonly')
    const values = await requestResult(tx.objectStore(storeName).index('attemptId').getAll(attemptId)) as T[]
    await transactionDone(tx)
    return values
  }

  async listRecoverableAttempts() {
    const tx = this.database.transaction('attempts', 'readonly')
    const attempts = await requestResult(tx.objectStore('attempts').getAll()) as AttemptRecord[]
    await transactionDone(tx)
    return attempts.filter(attempt => !isTerminalAttemptState(attempt.state))
  }

  async listAttemptEvents(attemptId: string) {
    return (await this.listByAttempt<AttemptEventRecord>('events', attemptId)).sort((a, b) => a.sequence - b.sequence)
  }

  async listExternalArtifacts(attemptId: string) {
    return this.listByAttempt<ExternalArtifactRecord>('externalArtifacts', attemptId)
  }

  async listCleanupObligations(attemptId: string) {
    return this.listByAttempt<CleanupObligationRecord>('cleanupObligations', attemptId)
  }
}

export const requestVectorDigest = requestDigestFor
