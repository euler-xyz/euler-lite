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
 * submission can never overwrite another's. They persist in localStorage so
 * they survive cart clearing, account switches, and full page reloads — and
 * when durable storage is unavailable or rejects the write, an in-memory
 * fallback keeps the quarantine fail-closed for the rest of the session.
 * Records are removed only once reconciliation reaches a terminal verdict
 * (landed, not landed, or definitively rejected by the wallet).
 */

export type PendingSubmissionFlow = 'batch' | 'outgoing-migration' | 'inbound-migration'

export const PENDING_SUBMISSION_FLOWS: readonly PendingSubmissionFlow[]
  = ['batch', 'outgoing-migration', 'inbound-migration']

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
}

export interface ArmedPendingSubmission extends PendingSubmissionBase {
  readonly phase: 'armed'
  readonly kind?: undefined
  readonly hash?: undefined
}

export interface SubmittedPendingSubmission extends PendingSubmissionBase {
  readonly phase: 'submitted'
  /** 'transaction' = EOA send; 'proposal' = Safe proposal / bundle id. */
  readonly kind: 'transaction' | 'proposal'
  readonly hash: Hash
}

export type PendingSubmissionRecord = ArmedPendingSubmission | SubmittedPendingSubmission

export type PendingSubmissionOutcome = 'landed' | 'not-landed' | 'unknown'

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
 * Fail-closed fallback: when localStorage is unavailable or a write does not
 * stick, the record must still block this session's retries rather than
 * silently degrade to "no quarantine".
 */
const memoryFallback = new Map<string, string>()

/** Test-only: module state would otherwise leak between test files' cases. */
export const resetPendingSubmissionMemoryFallback = () => {
  memoryFallback.clear()
}

const writeRaw = (key: string, value: string) => {
  const storage = getStorage()
  if (storage) {
    try {
      storage.setItem(key, value)
      // Read-back verification: a quota-exhausted or lying storage must not
      // count as durable persistence.
      if (storage.getItem(key) === value) {
        memoryFallback.delete(key)
        return
      }
    }
    catch (err) {
      logWarn('pendingSubmissions/write', err)
    }
  }
  memoryFallback.set(key, value)
}

const readRaw = (key: string): string | null => {
  const storage = getStorage()
  if (storage) {
    try {
      const raw = storage.getItem(key)
      if (raw !== null) return raw
    }
    catch {
      // Fall through to the in-memory fallback.
    }
  }
  return memoryFallback.get(key) ?? null
}

const removeRaw = (key: string) => {
  try {
    getStorage()?.removeItem(key)
  }
  catch {
    // Ignore unavailable browser storage.
  }
  memoryFallback.delete(key)
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
  }
  if (candidate.phase === 'armed') {
    return { phase: 'armed', ...base }
  }
  if (candidate.kind !== 'transaction' && candidate.kind !== 'proposal') return undefined
  if (!isHash(candidate.hash)) return undefined
  return { phase: 'submitted', kind: candidate.kind, hash: candidate.hash, ...base }
}

const readRecordAtKey = (key: string, expected?: { owner: Address, chainId: number }): PendingSubmissionRecord | undefined => {
  const raw = readRaw(key)
  if (raw === null) return undefined
  const record = parseRecord(raw)
  // A corrupt record (or one whose content disagrees with its key) cannot be
  // reconciled — drop it rather than blocking the flow forever on
  // unparseable state.
  if (!record || (expected && (record.owner !== expected.owner || record.chainId !== expected.chainId))) {
    removeRaw(key)
    return undefined
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

/** Every wallet's unresolved record for a flow, corrupt entries dropped. */
export const listPendingSubmissions = (flow: PendingSubmissionFlow): PendingSubmissionRecord[] => {
  const records: PendingSubmissionRecord[] = []
  for (const key of listRawKeys(pendingSubmissionStorageKeyPrefix(flow))) {
    const record = readRecordAtKey(key)
    if (record) records.push(record)
  }
  return records
}

export const writePendingSubmission = (flow: PendingSubmissionFlow, record: PendingSubmissionRecord) => {
  writeRaw(storageKey(flow, record.owner, record.chainId), JSON.stringify(record))
}

export const clearPendingSubmission = (flow: PendingSubmissionFlow, owner: Address, chainId: number) => {
  removeRaw(storageKey(flow, owner, chainId))
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
 * or failed) produces a terminal verdict. 'unknown' must keep the record and
 * block re-execution of the same plan. An 'armed' record has no id to look
 * up, so it is always 'unknown' — it can only be released by the attempt that
 * armed it (rejection or confirmation).
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
  if (record.phase === 'armed') return 'unknown'
  const { provider } = options
  if (!provider) return 'unknown'

  if (record.kind === 'transaction') {
    try {
      const receipt = await provider.getTransactionReceipt({ hash: record.hash })
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
      submittedHash: record.hash,
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
