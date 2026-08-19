import type { Address } from 'viem'
import { getAddress } from 'viem'
import type { PreparedPlanBroadcast } from '~/composables/useEulerTx'
import type { ReceiptClientLike, WalletConnectorLike, WalletProviderLike } from '~/utils/safeWalletTransactions'
import {
  armPendingSubmission,
  clearPendingSubmission,
  createPendingSubmissionAttemptId,
  readPendingSubmission,
  releasePendingSubmission,
  releaseUnverifiablePendingSubmission,
  resolvePendingSubmissionOutcome,
  upgradePendingSubmissionToSubmitted,
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
 * Replay protection for value-moving plan execution outside the batch cart
 * (the direct forms and both migration pages). The record is persisted at the
 * wallet boundary, not after the failure:
 *
 * - 'armed' is reserved atomically (check + reserve under the per-wallet
 *   lock, with this attempt's id) before the wallet is invoked for a
 *   value-moving send — the wallet may accept the request and then fail to
 *   return its id, and a reload in that window must still find the
 *   quarantine. A reservation another attempt holds, or one that cannot be
 *   proven durable, throws here and the wallet is never invoked.
 * - the record upgrades to 'submitted' the moment an id exists
 *   (ownership-checked), and is released only on a terminal signal: the
 *   receipt confirmed, or the wallet definitively rejected the request.
 *
 * `reconcileBeforeAttempt` resolves the durable record on-chain before the
 * next attempt is allowed to send anything: an unresolved outcome throws and
 * blocks the retry. `sealFailure` merely reports whether the failed attempt
 * left a quarantined submission behind — persistence already happened.
 * `releaseArmedAfterManualCheck` is the risk-labelled recovery for an armed
 * record orphaned by a reload: it releases only after the user confirmed the
 * wallet itself shows nothing pending, and refuses submitted records.
 */
export const createDirectSubmissionQuarantine = (options: {
  flow: PendingSubmissionFlow
  getSafeWalletProvider: (connector?: WalletConnectorLike) => Promise<WalletProviderLike | undefined>
  safeStatusTimeoutMs?: number
}) => {
  let attempt: { owner: Address, chainId: number, attemptId: string } | undefined
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
    // An unreadable/corrupt record throws out of the read: fail closed.
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
    // Compare-and-delete: only the exact reconciled record is released — a
    // record another attempt reserved during the on-chain check survives.
    await clearPendingSubmission(options.flow, record.owner, record.chainId, { ifMatches: record })
    if (outcome === 'not-landed') return 'clear'
    return record.completesPlan ? 'landed' : 'landed-partial'
  }

  /** Arm tracking for one attempt. Must run before any wallet action. */
  const begin = (input: { owner: Address, chainId: number }) => {
    attempt = {
      owner: getAddress(input.owner),
      chainId: input.chainId,
      attemptId: createPendingSubmissionAttemptId(),
    }
    unconfirmed = undefined
  }

  /**
   * onBroadcast sink for the plan executors. Persists the quarantine at the
   * wallet boundary (the executor awaits the armed emission before invoking
   * the wallet); only value-moving items (the Safe bundle or the EVC batch)
   * quarantine — ambiguous approvals and plugin prerequisites are idempotent
   * and safe to re-run. All record mutations are ownership-checked with this
   * attempt's id, so a stale completion can never release or overwrite a
   * reservation a newer attempt holds.
   */
  const track = async (broadcast: PreparedPlanBroadcast): Promise<void> => {
    if (broadcast.status === 'armed' || broadcast.status === 'submitted') {
      // A submitted broadcast is ambiguous no matter what happens below — the
      // wallet already returned an id. An armed one becomes ambiguous only
      // once the reservation succeeded: a throw here aborts the attempt
      // before the wallet is invoked, so nothing is outstanding.
      if (broadcast.status === 'submitted') unconfirmed = broadcast
      if (attempt && isValueMoving(broadcast)) {
        if (broadcast.status === 'armed') {
          await armPendingSubmission(options.flow, {
            owner: attempt.owner,
            chainId: attempt.chainId,
            completesPlan: broadcast.completesPlan,
            attemptId: attempt.attemptId,
          })
        }
        else {
          await upgradePendingSubmissionToSubmitted(options.flow, {
            owner: attempt.owner,
            chainId: attempt.chainId,
            attemptId: attempt.attemptId,
            kind: broadcast.kind,
            hash: broadcast.hash,
            completesPlan: broadcast.completesPlan,
          })
        }
      }
      if (broadcast.status === 'armed') unconfirmed = broadcast
      return
    }
    // 'rejected' (the wallet provably never accepted the armed request) and
    // 'confirmed' (the receipt landed) are both terminal for the record.
    if (attempt && isValueMoving(broadcast)) {
      await releasePendingSubmission(options.flow, attempt.owner, attempt.chainId, {
        attemptId: attempt.attemptId,
      })
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

  /**
   * Risk-labelled manual recovery: release an armed (or corrupt) record that
   * can never resolve on its own because the attempt that armed it is gone.
   * Callers must only invoke this after the user explicitly confirmed the
   * wallet shows no pending request. Submitted records are refused — they
   * carry an id and are verified on-chain instead.
   */
  const releaseArmedAfterManualCheck = (input: { owner: Address, chainId: number }) =>
    releaseUnverifiablePendingSubmission(options.flow, input.owner, input.chainId, {
      userConfirmedWalletShowsNoPendingSubmission: true,
    })

  return { reconcileBeforeAttempt, begin, track, sealFailure, releaseArmedAfterManualCheck }
}
