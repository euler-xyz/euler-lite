import { getAddress, type Address, type Hash } from 'viem'

export const PENDING_SAFE_REVIEWED_SUBMISSION_KEY = 'euler-lite:pending-safe-reviewed-submissions:v1'

export interface PendingSafeReviewedSubmission {
  reservationId: string
  reviewId: Hash
  reviewDigest: Hash
  requestDigest: Hash
  account: Address
  chainId: number
  callsId?: Hash
  createdAt: number
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const isHash = (value: unknown): value is Hash =>
  typeof value === 'string' && /^0x[0-9a-fA-F]{64}$/.test(value)

const normalize = (value: unknown): PendingSafeReviewedSubmission | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<PendingSafeReviewedSubmission>
  if (
    typeof candidate.reservationId !== 'string'
    || !candidate.reservationId
    || !isHash(candidate.reviewId)
    || !isHash(candidate.reviewDigest)
    || !isHash(candidate.requestDigest)
    || typeof candidate.account !== 'string'
    || !Number.isSafeInteger(candidate.chainId)
    || candidate.chainId! <= 0
    || (candidate.callsId !== undefined && !isHash(candidate.callsId))
    || !Number.isSafeInteger(candidate.createdAt)
    || candidate.createdAt! <= 0
  ) return undefined

  try {
    return {
      reservationId: candidate.reservationId,
      reviewId: candidate.reviewId,
      reviewDigest: candidate.reviewDigest,
      requestDigest: candidate.requestDigest,
      account: getAddress(candidate.account),
      chainId: candidate.chainId!,
      ...(candidate.callsId ? { callsId: candidate.callsId } : {}),
      createdAt: candidate.createdAt!,
    }
  }
  catch {
    return undefined
  }
}

export const loadPendingSafeReviewedSubmissions = (storage: StorageLike): PendingSafeReviewedSubmission[] => {
  let raw: string | null
  try {
    raw = storage.getItem(PENDING_SAFE_REVIEWED_SUBMISSION_KEY)
  }
  catch (cause) {
    throw new Error('Pending Safe submission storage is unavailable. Verify the Safe before retrying.', { cause })
  }
  if (raw === null) return []

  let values: unknown
  try {
    values = JSON.parse(raw)
  }
  catch (cause) {
    throw new Error('Pending Safe submission storage is unreadable. Verify the Safe before retrying.', { cause })
  }
  if (!Array.isArray(values)) throw new Error('Pending Safe submission storage is invalid. Verify the Safe before retrying.')
  const normalized = values.map(normalize)
  if (normalized.some(value => !value)) throw new Error('Pending Safe submission storage is invalid. Verify the Safe before retrying.')
  return normalized as PendingSafeReviewedSubmission[]
}

const save = (storage: StorageLike, records: readonly PendingSafeReviewedSubmission[]) => {
  if (!records.length) {
    storage.removeItem(PENDING_SAFE_REVIEWED_SUBMISSION_KEY)
    return
  }
  storage.setItem(PENDING_SAFE_REVIEWED_SUBMISSION_KEY, JSON.stringify(records))
}

export const findPendingSafeReviewedSubmission = (
  storage: StorageLike,
  account: Address,
  chainId: number,
) => loadPendingSafeReviewedSubmissions(storage).find(record =>
  record.chainId === chainId && record.account.toLowerCase() === account.toLowerCase(),
)

export const reservePendingSafeReviewedSubmission = (
  storage: StorageLike,
  record: PendingSafeReviewedSubmission,
) => {
  const records = loadPendingSafeReviewedSubmissions(storage)
  if (records.some(existing => existing.chainId === record.chainId && existing.account.toLowerCase() === record.account.toLowerCase())) {
    throw new Error('A previous Safe submission for this account is unresolved. Reconcile it before retrying.')
  }
  save(storage, [...records, record])
}

export const attachPendingSafeCallsId = (
  storage: StorageLike,
  reservationId: string,
  callsId: Hash,
) => {
  const records = loadPendingSafeReviewedSubmissions(storage)
  const index = records.findIndex(record => record.reservationId === reservationId)
  if (index < 0) throw new Error('The pending Safe reservation disappeared after wallet handoff.')
  const current = records[index]!
  records[index] = { ...current, callsId }
  save(storage, records)
}

export const clearPendingSafeReviewedSubmission = (storage: StorageLike, reservationId: string) => {
  const records = loadPendingSafeReviewedSubmissions(storage)
  save(storage, records.filter(record => record.reservationId !== reservationId))
}

export const clearHashlessPendingSafeReviewedSubmission = (
  storage: StorageLike,
  context: { reservationId: string, account: Address, chainId: number, confirmedAbsent: boolean },
) => {
  if (!context.confirmedAbsent) throw new Error('Confirm that Safe contains no proposal before clearing this lock.')
  const record = loadPendingSafeReviewedSubmissions(storage).find(candidate => candidate.reservationId === context.reservationId)
  if (!record || record.callsId || record.account !== getAddress(context.account) || record.chainId !== context.chainId) {
    throw new Error('The pending Safe reservation context changed. Review it again before clearing.')
  }
  clearPendingSafeReviewedSubmission(storage, context.reservationId)
}

export const createSafeReservationId = () => {
  const random = globalThis.crypto?.randomUUID?.()
  return random ?? `${Date.now()}-${Math.random().toString(16).slice(2)}`
}
