import { getAddress, type Address, type Hash } from 'viem'
import type { TransactionPlan, TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import type { MigrationAuthorizationRevoke } from '~/utils/migrationAuthorizationTxs'

export const PENDING_SAFE_BATCH_STORAGE_KEY = 'euler-lite:pending-safe-batch-submissions:v1'

export interface PersistedPendingSafeBatchSubmission {
  /** Absent while durable storage is reserved before the Safe wallet is opened. */
  submittedHash?: Hash
  /** Distinguishes a prerequisite transaction from the terminal EVC batch. */
  submissionKind?: 'batch' | 'prerequisite'
  account: Address
  chainId: number
  batchFingerprint: string
  batchPlan: TransactionPlan
  errorMessage: string
  refreshExternalMigrationPositions: boolean
  grantedRevokes: MigrationAuthorizationRevoke[]
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
    || (candidate.submissionKind !== undefined
      && candidate.submissionKind !== 'batch'
      && candidate.submissionKind !== 'prerequisite')
    || typeof candidate.account !== 'string'
    || !Number.isSafeInteger(candidate.chainId)
    || typeof candidate.batchFingerprint !== 'string'
    || candidate.batchFingerprint.length !== 16
    || !Array.isArray(candidate.batchPlan)
    || typeof candidate.errorMessage !== 'string'
    || typeof candidate.refreshExternalMigrationPositions !== 'boolean'
    || !Array.isArray(candidate.grantedRevokes)
  ) return undefined
  const grantedRevokes = candidate.grantedRevokes.map(normalizeRevoke)
  if (grantedRevokes.some(revoke => !revoke)) return undefined
  try {
    return {
      ...(candidate.submittedHash === undefined ? {} : { submittedHash: candidate.submittedHash }),
      ...(candidate.submissionKind === undefined ? {} : { submissionKind: candidate.submissionKind }),
      account: getAddress(candidate.account),
      chainId: candidate.chainId!,
      batchFingerprint: candidate.batchFingerprint,
      batchPlan: candidate.batchPlan as TransactionPlan,
      errorMessage: candidate.errorMessage,
      refreshExternalMigrationPositions: candidate.refreshExternalMigrationPositions,
      grantedRevokes: grantedRevokes as MigrationAuthorizationRevoke[],
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
  if (submissions.length === 0) {
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
