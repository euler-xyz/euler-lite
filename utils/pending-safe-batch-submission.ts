import { getAddress, type Address, type Hash } from 'viem'
import type { TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import type { MigrationAuthorizationRevoke } from '~/utils/migrationAuthorizationTxs'

export const PENDING_SAFE_BATCH_STORAGE_KEY = 'euler-lite:pending-safe-review-executions:v1'
export const SAFE_SUBMISSION_WITHOUT_HASH_ERROR = 'A Safe submission may already be in progress, but its hash was not retained. Verify the Safe transaction before retrying.'
export const SAFE_SUBMISSION_UNRESOLVED_ERROR = 'The Safe transaction status is still unresolved. Reconcile it before retrying.'

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
}

type StorageLike = Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>

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
    }
  }
  catch {
    return undefined
  }
}

export const loadPendingSafeBatchSubmissions = (
  storage: StorageLike,
): PersistedPendingSafeBatchSubmission[] => {
  try {
    const raw = storage.getItem(PENDING_SAFE_BATCH_STORAGE_KEY)
    if (!raw) return []
    const values = parse(raw)
    if (!Array.isArray(values)) return []
    return values.map(normalizeRecord).filter((value): value is PersistedPendingSafeBatchSubmission => Boolean(value))
  }
  catch {
    return []
  }
}

export const savePendingSafeBatchSubmissions = (
  storage: StorageLike,
  submissions: PersistedPendingSafeBatchSubmission[],
) => {
  if (!submissions.length) {
    storage.removeItem(PENDING_SAFE_BATCH_STORAGE_KEY)
    return
  }
  storage.setItem(PENDING_SAFE_BATCH_STORAGE_KEY, stringify(submissions))
}

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
