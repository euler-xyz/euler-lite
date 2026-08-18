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

/**
 * Replay protection for the direct (non-cart) migration flows. Once a wallet
 * accepts a value-moving submission (an EOA transaction or a Safe proposal),
 * a receipt or Safe-status failure no longer means "nothing happened" — the
 * submission can still confirm later. `sealFailure` retains its hash/proposal
 * id durably, keyed by wallet and chain, and `reconcileBeforeAttempt`
 * resolves that record on-chain before the next attempt is allowed to send
 * anything: an unresolved outcome throws and blocks the retry.
 */
export const createDirectSubmissionQuarantine = (options: {
  flow: PendingSubmissionFlow
  getSafeWalletProvider: (connector?: WalletConnectorLike) => Promise<WalletProviderLike | undefined>
  safeStatusTimeoutMs?: number
}) => {
  let attempt: { owner: Address, chainId: number } | undefined
  // The executor re-fires each broadcast as 'confirmed' once its receipt
  // landed, so at most the single latest 'submitted' broadcast is ambiguous.
  let unconfirmed: PreparedPlanBroadcast | undefined

  const reconcileBeforeAttempt = async (input: {
    owner: Address
    chainId: number
    provider: ReceiptClientLike | undefined
    connector?: WalletConnectorLike
  }): Promise<DirectQuarantineVerdict> => {
    const record = readPendingSubmission(options.flow)
    if (!record) return 'clear'
    if (record.owner !== getAddress(input.owner) || record.chainId !== input.chainId) {
      // A different wallet/chain owns the record — nothing this attempt sends
      // can duplicate it. The record stays for the wallet that owns it.
      return 'clear'
    }
    const outcome = await resolvePendingSubmissionOutcome(record, {
      provider: input.provider,
      getSafeWalletProvider: options.getSafeWalletProvider,
      connector: input.connector,
      safeStatusTimeoutMs: options.safeStatusTimeoutMs ?? 8_000,
    })
    if (outcome === 'unknown') {
      throw new Error(PENDING_SUBMISSION_UNRESOLVED_ERROR)
    }
    clearPendingSubmission(options.flow)
    if (outcome === 'not-landed') return 'clear'
    return record.completesPlan ? 'landed' : 'landed-partial'
  }

  /** Arm tracking for one attempt. Must run before any wallet action. */
  const begin = (input: { owner: Address, chainId: number }) => {
    attempt = { owner: getAddress(input.owner), chainId: input.chainId }
    unconfirmed = undefined
  }

  /** onBroadcast sink for executePreparedPlan / …WithPlainCalls. */
  const track = (broadcast: PreparedPlanBroadcast) => {
    unconfirmed = broadcast.status === 'submitted' ? broadcast : undefined
  }

  /**
   * Persist the ambiguous submission after a failed attempt. Returns true
   * when something was quarantined — only a value-moving submission (the
   * Safe bundle or the EVC batch) qualifies; ambiguous approvals and plugin
   * prerequisites are idempotent and safe to re-run.
   */
  const sealFailure = (): boolean => {
    if (!attempt || !unconfirmed) return false
    if (unconfirmed.item !== 'bundle' && unconfirmed.item !== 'evcBatch') return false
    writePendingSubmission(options.flow, {
      kind: unconfirmed.kind,
      hash: unconfirmed.hash,
      chainId: attempt.chainId,
      owner: attempt.owner,
      completesPlan: unconfirmed.completesPlan,
      submittedAt: Date.now(),
    })
    return true
  }

  return { reconcileBeforeAttempt, begin, track, sealFailure }
}
