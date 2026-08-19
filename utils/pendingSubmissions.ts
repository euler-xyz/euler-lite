import type { Address, Hash } from 'viem'
import { getAddress } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import type { ReceiptClientLike, WalletConnectorLike, WalletProviderLike } from '~/utils/safeWalletTransactions'
import { SafeTransactionStatusUnknownError, waitForSafeTransactionExecution } from '~/utils/safeWalletTransactions'

/**
 * Durable quarantine records for value-moving submissions whose outcome is
 * unknown. Two phases exist:
 *
 * - 'armed': the wallet was invoked but no transaction hash / Safe proposal id
 *   came back yet (or ever — the wallet may accept a request and then fail to
 *   return its id). An armed record can never be verified on-chain, so it
 *   resolves to 'unknown' until the same attempt upgrades it to 'submitted'
 *   or the wallet definitively rejects the request.
 * - 'submitted': the wallet accepted the send and returned an id, but no
 *   terminal receipt/status was observed. The submission can still confirm
 *   later, so re-running the flow without resolving it risks executing the
 *   operation twice.
 *
 * Records are keyed by flow + chain + owner so one wallet's unresolved
 * submission can never overwrite another's, and each carries the attempt id
 * that reserved it so only that attempt can upgrade or release it. They
 * persist in localStorage and survive cart clearing, account switches, and
 * full page reloads. Persistence is durable-or-abort: a reservation that
 * cannot be proven durable (storage unavailable, write rejected, or read-back
 * mismatch) throws before the wallet is ever invoked, and reads fail closed —
 * unreadable or corrupt state blocks new submissions instead of being
 * silently treated as "no quarantine". Records are removed only once
 * reconciliation reaches a terminal verdict (landed, not landed, definitively
 * rejected by the wallet, or an explicit user-acknowledged manual release of
 * an armed record).
 */

export type PendingSubmissionFlow = 'batch' | 'outgoing-migration' | 'inbound-migration' | 'direct' | 'cow-order'

export const PENDING_SUBMISSION_FLOWS: readonly PendingSubmissionFlow[]
  = ['batch', 'outgoing-migration', 'inbound-migration', 'direct', 'cow-order']

interface PendingSubmissionBase {
  readonly chainId: number
  readonly owner: Address
  /**
   * Whether this submission was the plan's final value-moving item. When it
   * landed but did not complete the plan, the remainder must be re-reviewed
   * rather than silently treated as done.
   */
  readonly completesPlan: boolean
  readonly refreshExternalPositions?: boolean
  readonly submittedAt: number
  /**
   * Identity of the attempt that reserved this record. Upgrades and terminal
   * releases are ownership-checked against it so one tab's completion can
   * never delete or overwrite another tab's pending reservation.
   */
  readonly attemptId?: string
}

/**
 * A verifiable id observed for a record that is still stored as 'armed': the
 * wallet returned the id, but the armed → submitted durable rewrite failed.
 * Preserving the id on the armed record keeps the submission objectively
 * verifiable (receipt / Safe status / orderbook lookup) and makes it
 * unrecoverable through the hashless manual-release path.
 */
export type PendingSubmissionObservedId
  = | { readonly kind: 'transaction' | 'proposal', readonly hash: Hash }
    | { readonly kind: 'cow-order', readonly orderUid: string, readonly orderbookUrl?: string }

export interface ArmedPendingSubmission extends PendingSubmissionBase {
  readonly phase: 'armed'
  readonly kind?: undefined
  readonly hash?: undefined
  readonly orderUid?: undefined
  readonly observedId?: PendingSubmissionObservedId
}

export interface SubmittedPendingSubmission extends PendingSubmissionBase {
  readonly phase: 'submitted'
  /** 'transaction' = EOA send; 'proposal' = Safe proposal / bundle id. */
  readonly kind: 'transaction' | 'proposal'
  readonly hash: Hash
  readonly orderUid?: undefined
  readonly observedId?: undefined
}

export interface SubmittedCowOrderPendingSubmission extends PendingSubmissionBase {
  readonly phase: 'submitted'
  /** A CoW Swap order accepted by the orderbook, identified by its order uid. */
  readonly kind: 'cow-order'
  readonly orderUid: string
  readonly orderbookUrl?: string
  readonly hash?: undefined
  readonly observedId?: undefined
}

export type PendingSubmissionRecord
  = ArmedPendingSubmission | SubmittedPendingSubmission | SubmittedCowOrderPendingSubmission

export type PendingSubmissionOutcome = 'landed' | 'not-landed' | 'unknown'

/**
 * The quarantine's storage layer failed in a way that cannot be tolerated at
 * a wallet boundary: a reservation write could not be proven durable, or an
 * existing record could not be read or parsed. Both must stop the attempt
 * before the wallet is invoked.
 */
export class PendingSubmissionStorageError extends Error {}

/** Another attempt already holds this wallet/chain's reservation. */
export class PendingSubmissionConflictError extends Error {
  constructor() {
    super('Another transaction from this wallet was just handed to the wallet. Wait for it to resolve before sending anything new.')
  }
}

const STORAGE_PREFIX = 'euler_pending_submission'

export const pendingSubmissionStorageKeyPrefix = (flow: PendingSubmissionFlow) =>
  `${STORAGE_PREFIX}:${flow}:`

const storageKey = (flow: PendingSubmissionFlow, owner: Address, chainId: number) =>
  `${pendingSubmissionStorageKeyPrefix(flow)}${chainId}:${getAddress(owner)}`

const getStorage = (): Storage | undefined => {
  try {
    return globalThis.localStorage ?? undefined
  }
  catch {
    return undefined
  }
}

/**
 * Secondary in-realm guard. Reservations require durable storage — a write
 * that lands only here still throws — but the copy kept here additionally
 * blocks the current realm's retries after that throw is surfaced, and it is
 * the read authority when the realm has no storage object at all.
 */
const memoryFallback = new Map<string, string>()

/**
 * In-realm change feed so recovery surfaces can react to records being
 * created, upgraded, or released without polling. Cross-tab changes are
 * observed separately via the window 'storage' event.
 */
const changeListeners = new Set<() => void>()

export const subscribeToPendingSubmissionChanges = (listener: () => void): (() => void) => {
  changeListeners.add(listener)
  return () => changeListeners.delete(listener)
}

const notifyPendingSubmissionChange = () => {
  for (const listener of [...changeListeners]) {
    try {
      listener()
    }
    catch (err) {
      logWarn('pendingSubmissions/change-listener', err)
    }
  }
}

/**
 * Attempt ids whose execution flow is still live in this realm. Recovery
 * surfaces use this to distinguish an orphaned armed record (owning attempt
 * died in a reload/crash) from one whose wallet prompt is open right now.
 */
const activeAttemptIds = new Set<string>()

export const registerActiveSubmissionAttempt = (attemptId: string) => {
  activeAttemptIds.add(attemptId)
  notifyPendingSubmissionChange()
}

export const unregisterActiveSubmissionAttempt = (attemptId: string) => {
  if (activeAttemptIds.delete(attemptId)) notifyPendingSubmissionChange()
}

export const isSubmissionAttemptActive = (attemptId: string | undefined): boolean =>
  attemptId !== undefined && activeAttemptIds.has(attemptId)

/** Test-only: clears the in-realm guard AND purges quarantine keys from live
 * storage — module state and the storage polyfill would otherwise leak
 * between test cases. */
export const resetPendingSubmissionMemoryFallback = () => {
  memoryFallback.clear()
  const storage = getStorage()
  if (!storage) return
  try {
    const stale: string[] = []
    for (let i = 0; i < storage.length; i++) {
      const key = storage.key(i)
      if (key?.startsWith(STORAGE_PREFIX)) stale.push(key)
    }
    for (const key of stale) storage.removeItem(key)
  }
  catch {
    // Best-effort test cleanup only.
  }
}

/**
 * 'durable' only when the write stuck in real storage and read back exactly.
 * Everything else keeps an in-realm copy and reports 'memory' so callers that
 * require durability can abort before the wallet boundary.
 */
const writeRaw = (key: string, value: string): 'durable' | 'memory' => {
  const storage = getStorage()
  if (storage) {
    try {
      storage.setItem(key, value)
      // Read-back verification: a quota-exhausted or lying storage must not
      // count as durable persistence.
      if (storage.getItem(key) === value) {
        memoryFallback.delete(key)
        return 'durable'
      }
    }
    catch (err) {
      logWarn('pendingSubmissions/write', err)
    }
  }
  memoryFallback.set(key, value)
  return 'memory'
}

/**
 * Fail-closed read: when a storage object exists but its getter throws, an
 * existing durable record may be invisible — that cannot fall through to the
 * (possibly empty) in-realm map, it must throw and block the attempt. Only a
 * realm with no storage at all treats the in-realm map as the authority.
 */
const readRaw = (key: string): string | null => {
  const storage = getStorage()
  if (storage) {
    let raw: string | null
    try {
      raw = storage.getItem(key)
    }
    catch (err) {
      logWarn('pendingSubmissions/read', err)
      throw new PendingSubmissionStorageError(
        'Browser storage could not be read to verify pending submissions. Nothing was sent — resolve the storage issue (or restart the browser) and try again.',
      )
    }
    if (raw !== null) return raw
  }
  return memoryFallback.get(key) ?? null
}

const removeRaw = (key: string) => {
  try {
    getStorage()?.removeItem(key)
  }
  catch {
    // A failed durable remove leaves the record in place — fail-closed: the
    // stale record keeps blocking until storage recovers.
  }
  memoryFallback.delete(key)
  notifyPendingSubmissionChange()
}

const listRawKeys = (prefix: string): string[] => {
  const keys = new Set<string>()
  const storage = getStorage()
  if (storage) {
    try {
      for (let i = 0; i < storage.length; i++) {
        const key = storage.key(i)
        if (key?.startsWith(prefix)) keys.add(key)
      }
    }
    catch {
      // Fall through to the in-memory fallback.
    }
  }
  for (const key of memoryFallback.keys()) {
    if (key.startsWith(prefix)) keys.add(key)
  }
  return [...keys]
}

const isHash = (value: unknown): value is Hash =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value)

/** CoW order uids are 56 bytes: order digest + owner + validTo. */
const isCowOrderUid = (value: unknown): value is string =>
  typeof value === 'string' && /^0x[0-9a-f]{112}$/i.test(value)

const parseObservedId = (value: unknown): { observedId?: PendingSubmissionObservedId, valid: boolean } => {
  if (value === undefined) return { valid: true }
  if (!value || typeof value !== 'object') return { valid: false }
  const candidate = value as Record<string, unknown>
  if (candidate.kind === 'transaction' || candidate.kind === 'proposal') {
    if (!isHash(candidate.hash)) return { valid: false }
    return { observedId: { kind: candidate.kind, hash: candidate.hash }, valid: true }
  }
  if (candidate.kind === 'cow-order') {
    const orderUid = candidate.orderUid
    if (!isCowOrderUid(orderUid)) return { valid: false }
    if (candidate.orderbookUrl !== undefined && typeof candidate.orderbookUrl !== 'string') return { valid: false }
    return { observedId: { kind: 'cow-order', orderUid, orderbookUrl: candidate.orderbookUrl as string | undefined }, valid: true }
  }
  return { valid: false }
}

const parseRecord = (raw: string): PendingSubmissionRecord | undefined => {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    return undefined
  }
  if (!parsed || typeof parsed !== 'object') return undefined
  const candidate = parsed as Record<string, unknown>
  if (candidate.phase !== 'armed' && candidate.phase !== 'submitted') return undefined
  if (typeof candidate.chainId !== 'number' || !Number.isInteger(candidate.chainId) || candidate.chainId <= 0) return undefined
  if (typeof candidate.completesPlan !== 'boolean') return undefined
  if (candidate.refreshExternalPositions !== undefined && typeof candidate.refreshExternalPositions !== 'boolean') return undefined
  if (typeof candidate.submittedAt !== 'number' || !Number.isFinite(candidate.submittedAt)) return undefined
  if (candidate.attemptId !== undefined && typeof candidate.attemptId !== 'string') return undefined
  let owner: Address
  try {
    owner = getAddress(candidate.owner as string)
  }
  catch {
    return undefined
  }
  const base = {
    chainId: candidate.chainId,
    owner,
    completesPlan: candidate.completesPlan,
    refreshExternalPositions: candidate.refreshExternalPositions as boolean | undefined,
    submittedAt: candidate.submittedAt,
    attemptId: candidate.attemptId as string | undefined,
  }
  if (candidate.phase === 'armed') {
    // An unparseable observedId must corrupt the record (fail closed): it may
    // name a live submission, so it cannot degrade into a releasable hashless
    // armed record.
    const { observedId, valid } = parseObservedId(candidate.observedId)
    if (!valid) return undefined
    return { phase: 'armed', observedId, ...base }
  }
  if (candidate.kind === 'cow-order') {
    const orderUid = candidate.orderUid
    if (!isCowOrderUid(orderUid)) return undefined
    if (candidate.orderbookUrl !== undefined && typeof candidate.orderbookUrl !== 'string') return undefined
    return { phase: 'submitted', kind: 'cow-order', orderUid, orderbookUrl: candidate.orderbookUrl as string | undefined, ...base }
  }
  if (candidate.kind !== 'transaction' && candidate.kind !== 'proposal') return undefined
  if (!isHash(candidate.hash)) return undefined
  return { phase: 'submitted', kind: candidate.kind, hash: candidate.hash, ...base }
}

const corruptRecordError = () => new PendingSubmissionStorageError(
  'A stored pending-submission record could not be read, so a previous submission cannot be ruled out. Check the wallet\'s pending activity; if it shows nothing pending, the stuck record can be dismissed.',
)

/**
 * Fail-closed record read: corrupt or key-mismatched state throws instead of
 * being deleted — an unparseable record may still describe a live submission,
 * and silently dropping it would reopen the retry it exists to block. Only an
 * explicit user-acknowledged release (or the corrupting party fixing the
 * value) clears it.
 */
const readRecordAtKey = (key: string, expected?: { owner: Address, chainId: number }): PendingSubmissionRecord | undefined => {
  const raw = readRaw(key)
  if (raw === null) return undefined
  const record = parseRecord(raw)
  if (!record || (expected && (record.owner !== expected.owner || record.chainId !== expected.chainId))) {
    throw corruptRecordError()
  }
  return record
}

export const readPendingSubmission = (
  flow: PendingSubmissionFlow,
  owner: Address,
  chainId: number,
): PendingSubmissionRecord | undefined => {
  const normalizedOwner = getAddress(owner)
  return readRecordAtKey(storageKey(flow, normalizedOwner, chainId), { owner: normalizedOwner, chainId })
}

/**
 * Every wallet's readable record for a flow. Display/mirror use only: entries
 * that cannot be read or parsed are skipped (never deleted) so hydration at
 * module init cannot crash — attempt-time reads go through
 * `readPendingSubmission`, which fails closed on the same state.
 */
export const listPendingSubmissions = (flow: PendingSubmissionFlow): PendingSubmissionRecord[] => {
  const records: PendingSubmissionRecord[] = []
  for (const key of listRawKeys(pendingSubmissionStorageKeyPrefix(flow))) {
    try {
      const record = readRecordAtKey(key)
      if (record) records.push(record)
    }
    catch {
      // Unreadable/corrupt entries still block at attempt time.
    }
  }
  return records
}

/**
 * Durable-or-abort write: throws when the record cannot be proven durable.
 * The in-realm copy written on the failure path still blocks this realm's
 * retries, but a reservation that would not survive a reload must stop the
 * attempt before the wallet is invoked.
 */
/**
 * Quota headroom reserved by armed-record writes. The later armed → submitted
 * rewrite happens at the same key with a slightly larger payload (kind + id);
 * padding the armed record makes that rewrite a same-size-or-smaller
 * replacement, so a storage that accepted the reservation cannot refuse the
 * upgrade on quota grounds. `parseRecord` ignores unknown fields.
 */
const UPGRADE_HEADROOM_PADDING = 'x'.repeat(512)

export const writePendingSubmission = (
  flow: PendingSubmissionFlow,
  record: PendingSubmissionRecord,
  options?: { reserveUpgradeHeadroom?: boolean },
) => {
  const serialized = options?.reserveUpgradeHeadroom
    ? JSON.stringify({ ...record, padding: UPGRADE_HEADROOM_PADDING })
    : JSON.stringify(record)
  const outcome = writeRaw(storageKey(flow, record.owner, record.chainId), serialized)
  notifyPendingSubmissionChange()
  if (outcome !== 'durable') {
    throw new PendingSubmissionStorageError(
      'Replay protection could not be durably saved, so nothing was handed to the wallet. Check that browser storage is available and try again.',
    )
  }
}

/**
 * Per-owner/chain critical section for check+reserve and ownership-checked
 * mutations. Uses the browser-wide Web Locks API when available (serializing
 * across tabs) and always chains through an in-realm FIFO queue. Where Web
 * Locks are absent but records share a storage object with other contexts, a
 * storage-token mutex serializes across those contexts — and when it cannot
 * be acquired the attempt fails closed rather than running unserialized. Only
 * a realm with no storage at all relies on the FIFO alone: its records live
 * exclusively in this realm's memory map, so no other context can race them.
 */
const realmLockTails = new Map<string, Promise<void>>()

const STORAGE_LOCK_TTL_MS = 5_000
const STORAGE_LOCK_ACQUIRE_TIMEOUT_MS = 10_000
const STORAGE_LOCK_CONFIRM_DELAY_MS = 25
const STORAGE_LOCK_RETRY_DELAY_MS = 40

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms))

const storageLockUnavailableError = (cause?: unknown) => new PendingSubmissionStorageError(
  'Replay protection could not take the cross-tab submission lock, so nothing was handed to the wallet. Close other tabs of this app (or wait a moment) and try again.',
  cause === undefined ? undefined : { cause },
)

let storageLockTokenCounter = 0
const createStorageLockToken = (): string => {
  const uuid = (globalThis.crypto as Crypto | undefined)?.randomUUID?.()
  if (uuid) return uuid
  storageLockTokenCounter += 1
  return `lock-${Date.now()}-${Math.random()}-${storageLockTokenCounter}`
}

const readStorageLockHolder = (storage: Storage, key: string): { token?: unknown, expiresAt?: unknown } | undefined => {
  let raw: string | null
  try {
    raw = storage.getItem(key)
  }
  catch (err) {
    throw storageLockUnavailableError(err)
  }
  if (raw === null) return undefined
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed as { token?: unknown, expiresAt?: unknown } : undefined
  }
  catch {
    // An unparseable lock value is treated as an expired holder: the token
    // write below reclaims the slot, and the confirm re-read still arbitrates
    // against any concurrent claimant.
    return undefined
  }
}

/**
 * Cross-context mutex over the shared storage object: write a unique token
 * with a TTL, wait, and confirm the token survived. The TTL bounds how long a
 * crashed holder can block others; it is safe because every critical section
 * run under this lock does only synchronous storage work, finishing far
 * inside the TTL.
 */
const acquireStorageLock = async (storage: Storage, key: string): Promise<() => void> => {
  const token = createStorageLockToken()
  const deadline = Date.now() + STORAGE_LOCK_ACQUIRE_TIMEOUT_MS
  for (;;) {
    const holder = readStorageLockHolder(storage, key)
    const holderExpired = !holder
      || typeof holder.expiresAt !== 'number'
      || holder.expiresAt <= Date.now()
    if (holderExpired) {
      try {
        storage.setItem(key, JSON.stringify({ token, expiresAt: Date.now() + STORAGE_LOCK_TTL_MS }))
      }
      catch (err) {
        throw storageLockUnavailableError(err)
      }
      // Two contexts can both observe the slot free and both write; the delay
      // lets the racing writes settle so exactly one token survives re-read.
      await sleep(STORAGE_LOCK_CONFIRM_DELAY_MS + Math.floor(Math.random() * 15))
      const confirmed = readStorageLockHolder(storage, key)
      if (confirmed?.token === token) {
        return () => {
          try {
            const current = readStorageLockHolder(storage, key)
            if (current?.token === token) storage.removeItem(key)
          }
          catch {
            // Leave it to TTL expiry.
          }
        }
      }
    }
    if (Date.now() >= deadline) throw storageLockUnavailableError()
    await sleep(STORAGE_LOCK_RETRY_DELAY_MS + Math.floor(Math.random() * 20))
  }
}

export const withPendingSubmissionLock = async <T>(
  owner: Address,
  chainId: number,
  fn: () => Promise<T>,
): Promise<T> => {
  const key = `${STORAGE_PREFIX}:lock:${chainId}:${getAddress(owner)}`
  const runExclusive = async (): Promise<T> => {
    const locks = (globalThis.navigator as Navigator | undefined)?.locks
    if (locks?.request) {
      return locks.request(key, () => fn()) as Promise<T>
    }
    const storage = getStorage()
    if (storage) {
      const releaseLock = await acquireStorageLock(storage, key)
      try {
        return await fn()
      }
      finally {
        releaseLock()
      }
    }
    // No storage object exists: records are realm-local, so the in-realm FIFO
    // below already serializes every possible reader/writer.
    return fn()
  }
  const tail = realmLockTails.get(key) ?? Promise.resolve()
  const result = tail.then(runExclusive)
  realmLockTails.set(key, result.then(() => undefined, () => undefined))
  return result
}

let attemptIdCounter = 0
/** Identity for one execution attempt's reservation. */
export const createPendingSubmissionAttemptId = (): string => {
  const uuid = (globalThis.crypto as Crypto | undefined)?.randomUUID?.()
  if (uuid) return uuid
  attemptIdCounter += 1
  return `attempt-${Date.now()}-${attemptIdCounter}`
}

/**
 * Atomic check+reserve at the wallet boundary. Inside the per-owner/chain
 * lock it re-reads every flow's record and throws if any other attempt (any
 * flow, any surface, any tab) already holds a reservation — two tabs that
 * both passed the read-only gate cannot both invoke the wallet. Re-arming by
 * the same attempt (same attemptId) overwrites its own record.
 *
 * Throws before the wallet is invoked when the reservation cannot be proven
 * durable or existing state cannot be read.
 */
export const armPendingSubmission = async (
  flow: PendingSubmissionFlow,
  input: {
    owner: Address
    chainId: number
    completesPlan: boolean
    refreshExternalPositions?: boolean
    attemptId: string
  },
): Promise<ArmedPendingSubmission> => {
  const owner = getAddress(input.owner)
  return withPendingSubmissionLock(owner, input.chainId, async () => {
    for (const existingFlow of PENDING_SUBMISSION_FLOWS) {
      const existing = readPendingSubmission(existingFlow, owner, input.chainId)
      if (!existing) continue
      // Even this attempt's own record refuses re-arming once it carries a
      // submitted hash — overwriting it with a hashless armed record would
      // destroy the only verifiable id.
      if (existing.attemptId !== input.attemptId || existing.phase === 'submitted') {
        throw new PendingSubmissionConflictError()
      }
    }
    const record: ArmedPendingSubmission = {
      phase: 'armed',
      chainId: input.chainId,
      owner,
      completesPlan: input.completesPlan,
      refreshExternalPositions: input.refreshExternalPositions,
      submittedAt: Date.now(),
      attemptId: input.attemptId,
    }
    writePendingSubmission(flow, record, { reserveUpgradeHeadroom: true })
    return record
  })
}

export type PendingSubmissionUpgradeId
  = | { kind: 'transaction' | 'proposal', hash: Hash }
    | { kind: 'cow-order', orderUid: string, orderbookUrl?: string }

const describeUpgradeId = (id: PendingSubmissionUpgradeId): string =>
  id.kind === 'cow-order' ? `CoW Swap order ${id.orderUid}` : `transaction ${id.hash}`

/**
 * Ownership-checked armed → submitted upgrade. When the stored record is
 * missing, unreadable, or belongs to a different attempt, the upgrade is
 * refused (returning undefined) rather than overwriting state this attempt
 * does not own — whatever record exists keeps blocking, which is the safe
 * direction.
 *
 * A failed durable write of the submitted record must NOT degrade silently:
 * the wallet already accepted the submission and the returned id is the only
 * verifiable link to it. The id is preserved on the armed record as
 * `observedId` (best effort, retried) — which blocks the hashless
 * manual-release path and lets reconciliation verify the outcome objectively
 * — and the failure is thrown so the attempt surfaces it instead of
 * continuing as if the id had been recorded.
 */
export const upgradePendingSubmissionToSubmitted = async (
  flow: PendingSubmissionFlow,
  input: {
    owner: Address
    chainId: number
    attemptId: string
    completesPlan: boolean
    refreshExternalPositions?: boolean
  } & PendingSubmissionUpgradeId,
): Promise<SubmittedPendingSubmission | SubmittedCowOrderPendingSubmission | undefined> => {
  const owner = getAddress(input.owner)
  return withPendingSubmissionLock(owner, input.chainId, async () => {
    let existing: PendingSubmissionRecord | undefined
    try {
      existing = readPendingSubmission(flow, owner, input.chainId)
    }
    catch (err) {
      logWarn('pendingSubmissions/upgrade', err)
      return undefined
    }
    if (!existing || existing.attemptId !== input.attemptId) {
      logWarn('pendingSubmissions/upgrade', new Error(`refused upgrade of a reservation this attempt does not own (${describeUpgradeId(input)})`))
      return undefined
    }
    const base = {
      chainId: input.chainId,
      owner,
      completesPlan: input.completesPlan,
      refreshExternalPositions: input.refreshExternalPositions,
      submittedAt: Date.now(),
      attemptId: input.attemptId,
    }
    const record: SubmittedPendingSubmission | SubmittedCowOrderPendingSubmission
      = input.kind === 'cow-order'
        ? { phase: 'submitted', kind: 'cow-order', orderUid: input.orderUid, orderbookUrl: input.orderbookUrl, ...base }
        : { phase: 'submitted', kind: input.kind, hash: input.hash, ...base }
    let writeError: unknown
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        writePendingSubmission(flow, record)
        return record
      }
      catch (err) {
        writeError = err
        logWarn('pendingSubmissions/upgrade', err)
      }
    }
    // Preserve the observed id in the most durable form still available. The
    // armed rewrite is same-size-or-smaller than the padded reservation, so a
    // quota-bound storage that accepted the arm accepts this; even when it
    // does not, the in-realm copy written on its failure path keeps blocking
    // this realm's hashless release.
    const preservedBase: ArmedPendingSubmission = existing.phase === 'armed'
      ? existing
      : { phase: 'armed', ...base }
    const observedId: PendingSubmissionObservedId = input.kind === 'cow-order'
      ? { kind: 'cow-order', orderUid: input.orderUid, orderbookUrl: input.orderbookUrl }
      : { kind: input.kind, hash: input.hash }
    try {
      writePendingSubmission(flow, { ...preservedBase, observedId })
    }
    catch (err) {
      logWarn('pendingSubmissions/upgrade', err)
    }
    throw new PendingSubmissionStorageError(
      `The wallet accepted ${describeUpgradeId(input)}, but replay protection could not durably record its id. Do not retry — verify this submission's outcome before sending anything new.`,
      writeError === undefined ? undefined : { cause: writeError },
    )
  })
}

/**
 * Ownership-checked terminal release: removes the record only when it is
 * still owned by the given attempt. A stale completion callback (this tab's
 * attempt finishing after another tab reserved anew) is a no-op.
 */
export const releasePendingSubmission = async (
  flow: PendingSubmissionFlow,
  owner: Address,
  chainId: number,
  ownership: { attemptId: string },
): Promise<boolean> => {
  const normalizedOwner = getAddress(owner)
  return withPendingSubmissionLock(normalizedOwner, chainId, async () => {
    let existing: PendingSubmissionRecord | undefined
    try {
      existing = readPendingSubmission(flow, normalizedOwner, chainId)
    }
    catch {
      // Unreadable/corrupt: ownership is unprovable — keep it blocking.
      return false
    }
    if (!existing || existing.attemptId !== ownership.attemptId) return false
    removeRaw(storageKey(flow, normalizedOwner, chainId))
    return true
  })
}

/** Same submission (not merely same key): the reconcile-time identity check. */
const sameSubmissionRecord = (a: PendingSubmissionRecord, b: PendingSubmissionRecord) =>
  a.phase === b.phase
  && a.owner === b.owner
  && a.chainId === b.chainId
  && a.submittedAt === b.submittedAt
  && a.attemptId === b.attemptId
  && a.hash === b.hash
  && a.orderUid === b.orderUid

/**
 * Remove a record after reconciliation reached a terminal verdict. With
 * `ifMatches` this is compare-and-delete: the key is cleared only while it
 * still holds the exact record that was reconciled, so a record another
 * attempt wrote in the meantime survives. Without `ifMatches` the clear is
 * unconditional — reserved for tests and callers that provably hold no
 * concurrent writer.
 */
export const clearPendingSubmission = async (
  flow: PendingSubmissionFlow,
  owner: Address,
  chainId: number,
  expected?: { ifMatches: PendingSubmissionRecord },
): Promise<void> => {
  const normalizedOwner = getAddress(owner)
  await withPendingSubmissionLock(normalizedOwner, chainId, async () => {
    if (expected) {
      let existing: PendingSubmissionRecord | undefined
      try {
        existing = readPendingSubmission(flow, normalizedOwner, chainId)
      }
      catch {
        // Unreadable/corrupt is not the reconciled record — keep it blocking.
        return
      }
      if (!existing || !sameSubmissionRecord(existing, expected.ifMatches)) return
    }
    removeRaw(storageKey(flow, normalizedOwner, chainId))
  })
}

/**
 * Risk-labelled manual recovery for a reservation that can never resolve on
 * its own: an armed record whose attempt died (reload/crash before the wallet
 * answered) or a corrupt record. Both have no id to verify on-chain, so the
 * only safe release signal is the user checking the wallet itself — the
 * acknowledgement object exists to force call sites to present exactly that
 * check. A 'submitted' record is refused: it has an id and can still confirm,
 * so it must be verified on-chain, never dismissed.
 *
 * Returns true when a record was released, false when none existed.
 */
export const releaseUnverifiablePendingSubmission = async (
  flow: PendingSubmissionFlow,
  owner: Address,
  chainId: number,
  acknowledgement: { userConfirmedWalletShowsNoPendingSubmission: true },
): Promise<boolean> => {
  if (acknowledgement.userConfirmedWalletShowsNoPendingSubmission !== true) {
    throw new Error('Manual release requires the user to confirm the wallet shows no pending submission')
  }
  const normalizedOwner = getAddress(owner)
  return withPendingSubmissionLock(normalizedOwner, chainId, async () => {
    const key = storageKey(flow, normalizedOwner, chainId)
    const raw = readRaw(key)
    if (raw === null) return false
    // A submission id may have been observed even when the durable record
    // does not show it (the submitted rewrite failed and left the id only on
    // this realm's in-memory copy) — check both sources before treating the
    // record as hashless.
    const identifiedSubmission = [raw, memoryFallback.get(key)].some((source) => {
      if (source === undefined) return false
      const record = parseRecord(source)
      return record?.phase === 'submitted' || record?.observedId !== undefined
    })
    if (identifiedSubmission) {
      throw new Error('This submission has a transaction id and may still confirm on-chain — it is verified automatically and cannot be dismissed. Wait a moment and try again.')
    }
    // Armed or corrupt with no observed id: no id will ever arrive, so only
    // the user's own wallet check can rule acceptance out.
    removeRaw(key)
    return true
  })
}

export interface ReleasableArmedSubmission {
  readonly flow: PendingSubmissionFlow
  readonly chainId: number
  readonly owner: Address
  /** 'corrupt' entries block attempts but cannot be parsed into a record. */
  readonly state: 'armed' | 'corrupt'
  readonly record?: ArmedPendingSubmission
}

/**
 * Every stuck record that only a user-acknowledged manual release can clear:
 * armed records whose owning attempt is no longer live in this realm, plus
 * corrupt entries. Records that carry a verifiable id (submitted, or armed
 * with an observed id) are excluded — they resolve objectively and must never
 * be offered for dismissal.
 */
export const listReleasableArmedSubmissions = (
  flows: readonly PendingSubmissionFlow[],
): ReleasableArmedSubmission[] => {
  const entries: ReleasableArmedSubmission[] = []
  for (const flow of flows) {
    const prefix = pendingSubmissionStorageKeyPrefix(flow)
    for (const key of listRawKeys(prefix)) {
      const suffix = key.slice(prefix.length)
      const separator = suffix.indexOf(':')
      if (separator <= 0) continue
      const chainId = Number(suffix.slice(0, separator))
      if (!Number.isInteger(chainId) || chainId <= 0) continue
      let owner: Address
      try {
        owner = getAddress(suffix.slice(separator + 1))
      }
      catch {
        continue
      }
      let raw: string | null
      try {
        raw = readRaw(key)
      }
      catch {
        // Storage itself is unreadable — a release could not verify what it
        // removes, so nothing is offered.
        continue
      }
      if (raw === null) continue
      const record = parseRecord(raw)
      if (!record || record.owner !== owner || record.chainId !== chainId) {
        entries.push({ flow, chainId, owner, state: 'corrupt' })
        continue
      }
      if (record.phase !== 'armed' || record.observedId !== undefined) continue
      if (isSubmissionAttemptActive(record.attemptId)) continue
      entries.push({ flow, chainId, owner, state: 'armed', record })
    }
  }
  return entries
}

/**
 * Whether an error thrown at the wallet boundary proves the wallet never
 * accepted the request: an explicit user rejection, or a connector-level
 * failure that occurs before the request is dispatched. Anything else —
 * timeouts, malformed responses, dropped connections mid-request — leaves
 * acceptance possible and must keep the armed record.
 */
export const walletNeverAcceptedSubmission = (error: unknown): boolean => {
  const NEVER_DISPATCHED_NAMES = new Set([
    'UserRejectedRequestError',
    'ConnectorNotConnectedError',
    'ConnectorAccountNotFoundError',
    'ConnectorChainMismatchError',
    'ConnectorUnavailableReconnectingError',
  ])
  let current: unknown = error
  for (let depth = 0; depth < 10 && current; depth++) {
    if (typeof current === 'object') {
      const candidate = current as { name?: unknown, code?: unknown, cause?: unknown }
      // EIP-1193 userRejectedRequest
      if (candidate.code === 4001) return true
      if (typeof candidate.name === 'string' && NEVER_DISPATCHED_NAMES.has(candidate.name)) return true
      current = candidate.cause
      continue
    }
    break
  }
  return false
}

/**
 * Resolve whether a quarantined submission reached the chain.
 *
 * Fails toward 'unknown': only a definitive receipt (landed) or a definitive
 * negative signal (transaction unknown to the node / Safe reports cancelled
 * or failed / orderbook reports the order cancelled or expired) produces a
 * terminal verdict. 'unknown' must keep the record and block re-execution of
 * the same plan. An 'armed' record without an observed id has nothing to look
 * up, so it is always 'unknown' — it is released by the attempt that armed it
 * (rejection or confirmation) or by an explicit user-acknowledged manual
 * release after the wallet was checked. An armed record that does carry an
 * observed id (the submitted rewrite failed after the wallet returned the id)
 * is verified through that id exactly like a submitted record.
 */
export const resolvePendingSubmissionOutcome = async (
  record: PendingSubmissionRecord,
  options: {
    provider: ReceiptClientLike | undefined
    getSafeWalletProvider: (connector?: WalletConnectorLike) => Promise<WalletProviderLike | undefined>
    connector?: WalletConnectorLike
    safeStatusTimeoutMs?: number
  },
): Promise<PendingSubmissionOutcome> => {
  const verifiable: PendingSubmissionObservedId | undefined = record.phase === 'armed'
    ? record.observedId
    : record.kind === 'cow-order'
      ? { kind: 'cow-order', orderUid: record.orderUid, orderbookUrl: record.orderbookUrl }
      : { kind: record.kind, hash: record.hash }
  if (!verifiable) return 'unknown'

  if (verifiable.kind === 'cow-order') {
    try {
      // Loaded lazily so quarantine consumers that never touch CoW do not pull
      // the orderbook client into their module graph.
      const { fetchCowSwapOrderStatus } = await import('~/entities/cowswap')
      const status = await fetchCowSwapOrderStatus({
        orderUid: verifiable.orderUid,
        chainId: record.chainId,
        orderbookUrl: verifiable.orderbookUrl,
      })
      if (status.terminal) {
        // Terminal: traded/fulfilled means the swap settled on-chain;
        // cancelled/expired means it never can.
        return status.type === 'cancelled' || status.type === 'expired' ? 'not-landed' : 'landed'
      }
      // Open/scheduled/executing/…: the signed order is live and can still
      // settle at any moment (bounded by its deadline) — keep quarantining.
      return 'unknown'
    }
    catch {
      // Orderbook unreachable or the uid is unknown to it — an order signed
      // and possibly accepted elsewhere cannot be ruled out.
      return 'unknown'
    }
  }

  const { provider } = options
  if (!provider) return 'unknown'

  if (verifiable.kind === 'transaction') {
    try {
      const receipt = await provider.getTransactionReceipt({ hash: verifiable.hash })
      return receipt.status === 'success' ? 'landed' : 'not-landed'
    }
    catch {
      // viem throws TransactionReceiptNotFoundError while pending, but the
      // node may also have simply dropped the transaction — either way there
      // is no receipt, and a dropped transaction can still be re-broadcast
      // from a mempool copy. Without an inclusion proof stay quarantined.
      return 'unknown'
    }
  }

  let walletProvider: WalletProviderLike | undefined
  try {
    walletProvider = await options.getSafeWalletProvider(options.connector)
  }
  catch {
    walletProvider = undefined
  }
  if (!walletProvider) return 'unknown'
  try {
    const execution = await waitForSafeTransactionExecution({
      submittedHash: verifiable.hash,
      walletProvider,
      publicClient: provider,
      timeoutMs: options.safeStatusTimeoutMs ?? 15_000,
    })
    return execution.receipt.status === 'success' ? 'landed' : 'not-landed'
  }
  catch (error) {
    if (error instanceof SafeTransactionStatusUnknownError) return 'unknown'
    if (error instanceof Error && (
      error.message === 'Safe transaction was cancelled'
      || error.message === 'Safe transaction failed'
    )) {
      return 'not-landed'
    }
    logWarn('pendingSubmissions/safe-status', error)
    return 'unknown'
  }
}
