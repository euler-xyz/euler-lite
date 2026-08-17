import { getAddress, type Address, type Hash } from 'viem'
import type { TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import type { MigrationAuthorizationRevoke } from '~/utils/migrationAuthorizationTxs'

export const PENDING_SAFE_BATCH_STORAGE_KEY = 'euler-lite:pending-safe-review-executions:v1'
export const SAFE_SUBMISSION_WITHOUT_HASH_ERROR = 'A Safe submission may already be in progress, but its hash was not retained. Verify the Safe transaction before retrying.'
export const SAFE_SUBMISSION_UNRESOLVED_ERROR = 'The Safe transaction status is still unresolved. Reconcile it before retrying.'
export const SAFE_SUBMISSION_STORAGE_INVALID_ERROR = 'Safe submission history is unreadable or invalid. Restore browser storage before submitting another Safe transaction.'
export const SAFE_SUBMISSION_LOCK_UNAVAILABLE_ERROR = 'Cross-tab Safe submission locking is unavailable. Use a supported browser before submitting this transaction.'
export const SAFE_SUBMISSION_RESERVATION_LOST_ERROR = 'The Safe submission lock changed in another tab. No wallet request was sent.'

export type PendingSafeSubmissionKind = 'batch' | 'operation'

export interface PersistedPendingSafeBatchSubmission {
  /** Missing only for the durable reservation written before Safe is opened. */
  submittedHash?: Hash
  account: Address
  chainId: number
  batchFingerprint: string
  errorMessage: string
  grantedRevokes: MigrationAuthorizationRevoke[]
  /** Omitted records are interpreted as batch submissions for storage compatibility. */
  submissionKind?: PendingSafeSubmissionKind
  /** Present on newly acquired records; legacy records remain valid blockers. */
  reservationId?: string
  /** Reviewed cart entries removed after a reconciled batch succeeds. */
  batchEntryIds?: string[]
}

export type PendingSafeSubmissionStorage = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const stringify = (value: unknown) => JSON.stringify(
  value,
  (_key, item) => typeof item === 'bigint' ? { __eulerLiteBigInt: item.toString() } : item,
)

const parse = (value: string): unknown => JSON.parse(
  value,
  (_key, item) => item && typeof item === 'object' && '__eulerLiteBigInt' in item
    ? BigInt((item as { __eulerLiteBigInt: string }).__eulerLiteBigInt)
    : item,
)

const isHash = (value: unknown): value is Hash =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)

export const getPendingSafeSubmissionKind = (
  pending: PersistedPendingSafeBatchSubmission,
): PendingSafeSubmissionKind => pending.submissionKind ?? 'batch'

export const isDefinitiveWalletRejection = (error: unknown): boolean => {
  let current = error
  const seen = new WeakSet<object>()
  for (let depth = 0; depth < 8 && current && typeof current === 'object'; depth++) {
    if (seen.has(current)) return false
    seen.add(current)
    const code = (current as { code?: unknown }).code
    if (code === 4001 || code === '4001' || code === 'ACTION_REJECTED') return true
    current = (current as { cause?: unknown }).cause
  }
  return false
}

const normalizeRevoke = (value: unknown): MigrationAuthorizationRevoke | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<MigrationAuthorizationRevoke>
  const transaction = candidate.transaction
  const walletContext = candidate.walletContext
  if (
    !transaction
    || !walletContext
    || typeof transaction.to !== 'string'
    || typeof transaction.data !== 'string'
    || (transaction.value !== undefined && typeof transaction.value !== 'bigint')
    || typeof walletContext.account !== 'string'
    || !Number.isSafeInteger(walletContext.chainId)
  ) return undefined
  try {
    return {
      transaction: {
        to: getAddress(transaction.to),
        data: transaction.data,
        ...(transaction.value === undefined ? {} : { value: transaction.value }),
      },
      walletContext: {
        account: getAddress(walletContext.account),
        chainId: walletContext.chainId,
      },
    }
  }
  catch {
    return undefined
  }
}

const normalizeRecord = (value: unknown): PersistedPendingSafeBatchSubmission | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<PersistedPendingSafeBatchSubmission>
  if (
    (candidate.submittedHash !== undefined && !isHash(candidate.submittedHash))
    || typeof candidate.account !== 'string'
    || !Number.isSafeInteger(candidate.chainId)
    || typeof candidate.batchFingerprint !== 'string'
    || candidate.batchFingerprint.length !== 16
    || typeof candidate.errorMessage !== 'string'
    || !Array.isArray(candidate.grantedRevokes)
    || (candidate.submissionKind !== undefined
      && candidate.submissionKind !== 'batch'
      && candidate.submissionKind !== 'operation')
    || (candidate.reservationId !== undefined
      && (typeof candidate.reservationId !== 'string' || candidate.reservationId.length === 0))
    || (candidate.batchEntryIds !== undefined
      && (!Array.isArray(candidate.batchEntryIds)
        || candidate.batchEntryIds.some(id => typeof id !== 'string' || id.length === 0)))
  ) return undefined
  const grantedRevokes = candidate.grantedRevokes.map(normalizeRevoke)
  if (grantedRevokes.some(revoke => !revoke)) return undefined
  try {
    return {
      ...(candidate.submittedHash === undefined ? {} : { submittedHash: candidate.submittedHash }),
      account: getAddress(candidate.account),
      chainId: candidate.chainId!,
      batchFingerprint: candidate.batchFingerprint,
      errorMessage: candidate.errorMessage,
      grantedRevokes: grantedRevokes as MigrationAuthorizationRevoke[],
      ...(candidate.submissionKind === undefined ? {} : { submissionKind: candidate.submissionKind }),
      ...(candidate.reservationId === undefined ? {} : { reservationId: candidate.reservationId }),
      ...(candidate.batchEntryIds === undefined ? {} : { batchEntryIds: [...candidate.batchEntryIds] }),
    }
  }
  catch {
    return undefined
  }
}

export const loadPendingSafeBatchSubmissions = (
  storage: PendingSafeSubmissionStorage,
): PersistedPendingSafeBatchSubmission[] => {
  let raw: string | null
  try {
    raw = storage.getItem(PENDING_SAFE_BATCH_STORAGE_KEY)
  }
  catch (cause) {
    throw new Error(SAFE_SUBMISSION_STORAGE_INVALID_ERROR, { cause })
  }
  if (raw === null) return []

  try {
    const values = parse(raw)
    if (!Array.isArray(values)) throw new Error('Stored Safe submissions are not an array')
    const normalized = values.map(normalizeRecord)
    if (normalized.some(value => !value)) throw new Error('Stored Safe submission record is invalid')
    return normalized as PersistedPendingSafeBatchSubmission[]
  }
  catch (cause) {
    throw new Error(SAFE_SUBMISSION_STORAGE_INVALID_ERROR, { cause })
  }
}

export const savePendingSafeBatchSubmissions = (
  storage: PendingSafeSubmissionStorage,
  submissions: PersistedPendingSafeBatchSubmission[],
) => {
  if (!submissions.length) {
    storage.removeItem(PENDING_SAFE_BATCH_STORAGE_KEY)
    return
  }
  storage.setItem(PENDING_SAFE_BATCH_STORAGE_KEY, stringify(submissions))
}

const samePendingSafeSlot = (
  left: Pick<PersistedPendingSafeBatchSubmission, 'account' | 'chainId'>,
  right: Pick<PersistedPendingSafeBatchSubmission, 'account' | 'chainId'>,
) => left.account.toLowerCase() === right.account.toLowerCase()
  && left.chainId === right.chainId

const samePendingSafeReservation = (
  left: PersistedPendingSafeBatchSubmission,
  right: PersistedPendingSafeBatchSubmission,
) => {
  if (!samePendingSafeSlot(left, right)) return false
  if (left.reservationId || right.reservationId) {
    return Boolean(left.reservationId) && left.reservationId === right.reservationId
  }
  return left.batchFingerprint === right.batchFingerprint
    && left.submittedHash === right.submittedHash
    && getPendingSafeSubmissionKind(left) === getPendingSafeSubmissionKind(right)
}

const getPendingSafeLockManager = () => {
  if (typeof navigator === 'undefined' || !navigator.locks) {
    throw new Error(SAFE_SUBMISSION_LOCK_UNAVAILABLE_ERROR)
  }
  return navigator.locks
}

const withPendingSafeSubmissionLock = async <T>(
  pending: Pick<PersistedPendingSafeBatchSubmission, 'account' | 'chainId'>,
  callback: () => T | Promise<T>,
): Promise<T> => getPendingSafeLockManager().request(
  `${PENDING_SAFE_BATCH_STORAGE_KEY}:${pending.chainId}:${pending.account.toLowerCase()}`,
  { mode: 'exclusive' },
  callback,
)

let reservationSequence = 0
const createReservationId = () => globalThis.crypto?.randomUUID?.()
  ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}-${++reservationSequence}`

const assertPersistedReservation = (
  storage: PendingSafeSubmissionStorage,
  expected: PersistedPendingSafeBatchSubmission,
) => {
  const retained = loadPendingSafeBatchSubmissions(storage).find(candidate =>
    samePendingSafeReservation(candidate, expected),
  )
  if (!retained || retained.submittedHash !== expected.submittedHash) {
    throw new Error('Durable browser storage could not retain the Safe submission lock; Safe submission was blocked')
  }
  return retained
}

export const acquirePendingSafeSubmission = async (
  storage: PendingSafeSubmissionStorage,
  pending: Omit<PersistedPendingSafeBatchSubmission, 'reservationId'>,
): Promise<PersistedPendingSafeBatchSubmission> => withPendingSafeSubmissionLock(pending, () => {
  const previous = loadPendingSafeBatchSubmissions(storage)
  const existing = previous.find(candidate => samePendingSafeSlot(candidate, pending))
  if (existing) {
    throw new Error(existing.submittedHash ? existing.errorMessage : SAFE_SUBMISSION_WITHOUT_HASH_ERROR)
  }
  const acquired = { ...pending, reservationId: createReservationId() }
  savePendingSafeBatchSubmissions(storage, [...previous, acquired])
  return assertPersistedReservation(storage, acquired)
})

export const updatePendingSafeSubmission = async (
  storage: PendingSafeSubmissionStorage,
  current: PersistedPendingSafeBatchSubmission,
  next: PersistedPendingSafeBatchSubmission,
): Promise<PersistedPendingSafeBatchSubmission> => withPendingSafeSubmissionLock(current, () => {
  if (!current.reservationId || current.reservationId !== next.reservationId || !samePendingSafeSlot(current, next)) {
    throw new Error(SAFE_SUBMISSION_RESERVATION_LOST_ERROR)
  }
  const previous = loadPendingSafeBatchSubmissions(storage)
  const retained = previous.find(candidate => samePendingSafeSlot(candidate, current))
  if (!retained || retained.reservationId !== current.reservationId) {
    throw new Error(SAFE_SUBMISSION_RESERVATION_LOST_ERROR)
  }
  savePendingSafeBatchSubmissions(storage, previous.map(candidate =>
    samePendingSafeSlot(candidate, current) ? next : candidate,
  ))
  return assertPersistedReservation(storage, next)
})

export const clearPendingSafeSubmission = async (
  storage: PendingSafeSubmissionStorage,
  pending: PersistedPendingSafeBatchSubmission,
): Promise<void> => withPendingSafeSubmissionLock(pending, () => {
  const previous = loadPendingSafeBatchSubmissions(storage)
  const retained = previous.find(candidate => samePendingSafeSlot(candidate, pending))
  if (!retained) return
  if (!samePendingSafeReservation(retained, pending)) {
    throw new Error(SAFE_SUBMISSION_RESERVATION_LOST_ERROR)
  }
  savePendingSafeBatchSubmissions(storage, previous.filter(candidate =>
    !samePendingSafeSlot(candidate, pending),
  ))
  if (loadPendingSafeBatchSubmissions(storage).some(candidate => samePendingSafeSlot(candidate, pending))) {
    throw new Error('Durable browser storage could not clear the reconciled Safe submission lock')
  }
})

export const getPreparedBatchFingerprint = (prepared: TransactionPlanPrepared): string => {
  const serialized = stringify({
    chainId: prepared.chainId,
    account: typeof prepared.account === 'string' ? prepared.account.toLowerCase() : prepared.account.owner.toLowerCase(),
    usePermit2: prepared.usePermit2,
    unlimitedApproval: prepared.unlimitedApproval,
    plan: prepared.plan,
  })
  let hash = 14_695_981_039_346_656_037n
  for (let index = 0; index < serialized.length; index++) {
    hash ^= BigInt(serialized.charCodeAt(index))
    hash = BigInt.asUintN(64, hash * 1_099_511_628_211n)
  }
  return hash.toString(16).padStart(16, '0')
}
