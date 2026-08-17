import { getAddress, type Address, type Hash } from 'viem'

export const PENDING_SAFE_BUNDLE_STORAGE_KEY = 'euler-lite:pending-safe-bundle-submissions:v1'

export interface PendingSafeBundleSubmission {
  reservationId: string
  account: Address
  chainId: number
  /** Absent while the wallet request is armed but no trustworthy id exists. */
  submittedHash?: Hash
  errorMessage: string
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

const isHash = (value: unknown): value is Hash =>
  typeof value === 'string' && /^0x[0-9a-f]{64}$/i.test(value)

const normalizeRecord = (value: unknown): PendingSafeBundleSubmission | undefined => {
  if (!value || typeof value !== 'object') return undefined
  const candidate = value as Partial<PendingSafeBundleSubmission>
  if (
    typeof candidate.reservationId !== 'string'
    || candidate.reservationId.length === 0
    || typeof candidate.account !== 'string'
    || !Number.isSafeInteger(candidate.chainId)
    || (candidate.submittedHash !== undefined && !isHash(candidate.submittedHash))
    || typeof candidate.errorMessage !== 'string'
    || candidate.errorMessage.length === 0
  ) return undefined

  try {
    return {
      reservationId: candidate.reservationId,
      account: getAddress(candidate.account),
      chainId: candidate.chainId!,
      ...(candidate.submittedHash === undefined ? {} : { submittedHash: candidate.submittedHash }),
      errorMessage: candidate.errorMessage,
    }
  }
  catch {
    return undefined
  }
}

const isSameContext = (
  submission: Pick<PendingSafeBundleSubmission, 'account' | 'chainId'>,
  account: Address,
  chainId: number,
) => submission.account.toLowerCase() === account.toLowerCase() && submission.chainId === chainId

export const loadPendingSafeBundleSubmissions = (
  storage: StorageLike,
): PendingSafeBundleSubmission[] => {
  const raw = storage.getItem(PENDING_SAFE_BUNDLE_STORAGE_KEY)
  if (raw === null) return []

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  }
  catch {
    throw new Error('Pending Safe bundle storage is unreadable. Clear the saved Safe submission only after verifying it in Safe.')
  }
  if (!Array.isArray(parsed)) {
    throw new Error('Pending Safe bundle storage is invalid. Clear the saved Safe submission only after verifying it in Safe.')
  }
  const normalized = parsed.map(normalizeRecord)
  if (normalized.some(record => !record)) {
    throw new Error('Pending Safe bundle storage is invalid. Clear the saved Safe submission only after verifying it in Safe.')
  }
  return normalized as PendingSafeBundleSubmission[]
}

const savePendingSafeBundleSubmissions = (
  storage: StorageLike,
  submissions: PendingSafeBundleSubmission[],
) => {
  if (submissions.length === 0) {
    storage.removeItem(PENDING_SAFE_BUNDLE_STORAGE_KEY)
    return
  }
  storage.setItem(PENDING_SAFE_BUNDLE_STORAGE_KEY, JSON.stringify(submissions))
}

export const findPendingSafeBundleSubmission = (
  storage: StorageLike,
  account: Address,
  chainId: number,
) => loadPendingSafeBundleSubmissions(storage)
  .find(submission => isSameContext(submission, account, chainId))

export const reservePendingSafeBundleSubmission = (
  storage: StorageLike,
  reservation: PendingSafeBundleSubmission,
) => {
  const submissions = loadPendingSafeBundleSubmissions(storage)
  if (submissions.some(submission => isSameContext(submission, reservation.account, reservation.chainId))) {
    throw new Error('A previous Safe bundle submission is unresolved. Verify it in Safe before retrying.')
  }
  savePendingSafeBundleSubmissions(storage, [...submissions, reservation])
}

export const updatePendingSafeBundleSubmission = (
  storage: StorageLike,
  submission: PendingSafeBundleSubmission,
) => {
  const submissions = loadPendingSafeBundleSubmissions(storage)
  const index = submissions.findIndex(item => item.reservationId === submission.reservationId)
  if (index < 0) {
    throw new Error('The durable Safe bundle reservation is missing. Verify the submission in Safe before retrying.')
  }
  submissions[index] = submission
  savePendingSafeBundleSubmissions(storage, submissions)
}

export const clearPendingSafeBundleSubmission = (
  storage: StorageLike,
  reservationId: string,
) => {
  const submissions = loadPendingSafeBundleSubmissions(storage)
  savePendingSafeBundleSubmissions(
    storage,
    submissions.filter(submission => submission.reservationId !== reservationId),
  )
}

export const clearHashlessPendingSafeBundleSubmission = (
  storage: StorageLike,
  reservationId: string,
) => {
  const pending = loadPendingSafeBundleSubmissions(storage)
    .find(submission => submission.reservationId === reservationId)
  if (!pending) throw new Error('The pending Safe bundle reservation no longer exists.')
  if (pending.submittedHash) {
    throw new Error('Submitted Safe bundles must be reconciled by transaction hash.')
  }
  clearPendingSafeBundleSubmission(storage, reservationId)
}
