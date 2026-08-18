import type { Address } from 'viem'
import { getAddress } from 'viem'
import type { PreparedPlanBroadcast } from '~/composables/useEulerTx'
import type { ReceiptClientLike, WalletConnectorLike, WalletProviderLike } from '~/utils/safeWalletTransactions'
import {
  clearPendingSubmission,
  readPendingSubmission,
  resolvePendingSubmissionOutcome,
  writePendingSubmission,
  type PendingSubmissionFlow,
} from '~/utils/pendingSubmissions'

export const PENDING_SUBMISSION_UNRESOLVED_ERROR
  = 'A previous migration submission may still confirm on-chain and could not be verified yet. Wait a moment and try again — it is re-checked before anything is re-sent.'

export const PENDING_SUBMISSION_ARMED_ERROR
  = 'A previous attempt handed a submission to the wallet but no transaction id came back, so it cannot be verified automatically. Check the wallet\'s pending activity and let it resolve before trying again.'

/**
 * 'clear'          — no unresolved submission for this wallet/chain; proceed.
 * 'landed'         — a quarantined submission confirmed on-chain. It may be
 *                    this migration or an earlier one for the same wallet, so
 *                    the caller must refresh and force a fresh review, never
 *                    finalize the current attempt on it.
 * 'landed-partial' — it confirmed but was not the plan's final value-moving
 *                    item; the remainder needs a fresh review.
 */
export type DirectQuarantineVerdict = 'clear' | 'landed' | 'landed-partial'

const isValueMoving = (broadcast: PreparedPlanBroadcast) =>
  broadcast.item === 'bundle' || broadcast.item === 'evcBatch'

/**
 * Replay protection for the direct (non-cart) migration flows. The record is
 * persisted at the wallet boundary, not after the failure:
 *
 * - 'armed' is written before the wallet is invoked for a value-moving send —
 *   the wallet may accept the request and then fail to return its id, and a
 *   reload in that window must still find the quarantine.
 * - the record upgrades to 'submitted' the moment an id exists, and is
 *   released only on a terminal signal: the receipt confirmed, or the wallet
 *   definitively rejected the request before dispatching it.
 *
 * `reconcileBeforeAttempt` resolves the durable record on-chain before the
 * next attempt is allowed to send anything: an unresolved outcome throws and
 * blocks the retry. `sealFailure` merely reports whether the failed attempt
 * left a quarantined submission behind — persistence already happened.
 */
export const createDirectSubmissionQuarantine = (options: {
  flow: PendingSubmissionFlow
  getSafeWalletProvider: (connector?: WalletConnectorLike) => Promise<WalletProviderLike | undefined>
  safeStatusTimeoutMs?: number
}) => {
  let attempt: { owner: Address, chainId: number } | undefined
  // The executor re-fires each broadcast as 'confirmed' once its receipt
  // landed (and as 'rejected' when the wallet provably never accepted it),
  // so at most the single latest armed/submitted broadcast is ambiguous.
  let unconfirmed: PreparedPlanBroadcast | undefined

  const reconcileBeforeAttempt = async (input: {
    owner: Address
    chainId: number
    provider: ReceiptClientLike | undefined
    connector?: WalletConnectorLike
  }): Promise<DirectQuarantineVerdict> => {
    // Records are keyed by wallet and chain — a different wallet's record is
    // invisible here and stays quarantined for the wallet that owns it.
    const record = readPendingSubmission(options.flow, input.owner, input.chainId)
    if (!record) return 'clear'
    const outcome = await resolvePendingSubmissionOutcome(record, {
      provider: input.provider,
      getSafeWalletProvider: options.getSafeWalletProvider,
      connector: input.connector,
      safeStatusTimeoutMs: options.safeStatusTimeoutMs ?? 8_000,
    })
    if (outcome === 'unknown') {
      throw new Error(record.phase === 'armed' ? PENDING_SUBMISSION_ARMED_ERROR : PENDING_SUBMISSION_UNRESOLVED_ERROR)
    }
    clearPendingSubmission(options.flow, record.owner, record.chainId)
    if (outcome === 'not-landed') return 'clear'
    return record.completesPlan ? 'landed' : 'landed-partial'
  }

  /** Arm tracking for one attempt. Must run before any wallet action. */
  const begin = (input: { owner: Address, chainId: number }) => {
    attempt = { owner: getAddress(input.owner), chainId: input.chainId }
    unconfirmed = undefined
  }

  /**
   * onBroadcast sink for executePreparedPlan / …WithPlainCalls. Persists the
   * quarantine synchronously at the wallet boundary; only value-moving items
   * (the Safe bundle or the EVC batch) quarantine — ambiguous approvals and
   * plugin prerequisites are idempotent and safe to re-run.
   */
  const track = (broadcast: PreparedPlanBroadcast) => {
    if (broadcast.status === 'armed' || broadcast.status === 'submitted') {
      unconfirmed = broadcast
      if (attempt && isValueMoving(broadcast)) {
        writePendingSubmission(options.flow, {
          ...(broadcast.status === 'armed'
            ? { phase: 'armed' as const }
            : { phase: 'submitted' as const, kind: broadcast.kind, hash: broadcast.hash }),
          chainId: attempt.chainId,
          owner: attempt.owner,
          completesPlan: broadcast.completesPlan,
          submittedAt: Date.now(),
        })
      }
      return
    }
    // 'rejected' (the wallet provably never accepted the armed request) and
    // 'confirmed' (the receipt landed) are both terminal for the record.
    if (attempt && isValueMoving(broadcast)) {
      clearPendingSubmission(options.flow, attempt.owner, attempt.chainId)
    }
    unconfirmed = undefined
  }

  /**
   * Report whether the failed attempt left a quarantined submission behind.
   * The durable record was already written when the broadcast fired — this
   * only tells the caller which error message applies.
   */
  const sealFailure = (): boolean => {
    if (!attempt || !unconfirmed) return false
    return isValueMoving(unconfirmed)
  }

  return { reconcileBeforeAttempt, begin, track, sealFailure }
}
