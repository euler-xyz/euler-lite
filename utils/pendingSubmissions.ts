import type { Address, Hash } from 'viem'
import { getAddress } from 'viem'
import { logWarn } from '~/utils/errorHandling'
import type { ReceiptClientLike, WalletConnectorLike, WalletProviderLike } from '~/utils/safeWalletTransactions'
import { SafeTransactionStatusUnknownError, waitForSafeTransactionExecution } from '~/utils/safeWalletTransactions'

/**
 * Durable quarantine records for value-moving submissions whose outcome is
 * unknown: the wallet accepted the send (a transaction hash or Safe proposal
 * id exists) but no terminal receipt/status was observed before the attempt
 * failed. Such a submission can still confirm later, so re-running the flow
 * without first resolving it risks executing the migration twice.
 *
 * Records persist in localStorage so they survive cart clearing, account
 * switches, and full page reloads; they are removed only once reconciliation
 * reaches a terminal verdict (landed or not landed).
 */

export type PendingSubmissionFlow = 'batch' | 'outgoing-migration' | 'inbound-migration'

export interface PendingSubmissionRecord {
  /** 'transaction' = EOA send; 'proposal' = Safe proposal / bundle id. */
  readonly kind: 'transaction' | 'proposal'
  readonly hash: Hash
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

export type PendingSubmissionOutcome = 'landed' | 'not-landed' | 'unknown'

const storageKey = (flow: PendingSubmissionFlow) => `euler_pending_submission:${flow}`

const getStorage = (): Storage | undefined => {
  try {
    return globalThis.localStorage ?? undefined
  }
  catch {
    return undefined
  }
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
  if (candidate.kind !== 'transaction' && candidate.kind !== 'proposal') return undefined
  if (!isHash(candidate.hash)) return undefined
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
  return {
    kind: candidate.kind,
    hash: candidate.hash,
    chainId: candidate.chainId,
    owner,
    completesPlan: candidate.completesPlan,
    refreshExternalPositions: candidate.refreshExternalPositions as boolean | undefined,
    submittedAt: candidate.submittedAt,
  }
}

export const readPendingSubmission = (flow: PendingSubmissionFlow): PendingSubmissionRecord | undefined => {
  const storage = getStorage()
  if (!storage) return undefined
  let raw: string | null
  try {
    raw = storage.getItem(storageKey(flow))
  }
  catch {
    return undefined
  }
  if (raw === null) return undefined
  const record = parseRecord(raw)
  if (!record) {
    // A corrupt record cannot be reconciled — drop it rather than blocking
    // the flow forever on unparseable state.
    clearPendingSubmission(flow)
    return undefined
  }
  return record
}

export const writePendingSubmission = (flow: PendingSubmissionFlow, record: PendingSubmissionRecord) => {
  try {
    getStorage()?.setItem(storageKey(flow), JSON.stringify(record))
  }
  catch (err) {
    logWarn('pendingSubmissions/write', err)
  }
}

export const clearPendingSubmission = (flow: PendingSubmissionFlow) => {
  try {
    getStorage()?.removeItem(storageKey(flow))
  }
  catch {
    // Ignore unavailable browser storage.
  }
}

/**
 * Resolve whether a quarantined submission reached the chain.
 *
 * Fails toward 'unknown': only a definitive receipt (landed) or a definitive
 * negative signal (transaction unknown to the node / Safe reports cancelled
 * or failed) produces a terminal verdict. 'unknown' must keep the record and
 * block re-execution of the same plan.
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
