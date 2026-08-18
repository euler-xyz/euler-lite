import type { Address } from 'viem'
import { getAddress } from 'viem'
import type { ReceiptClientLike, WalletConnectorLike, WalletProviderLike } from '~/utils/safeWalletTransactions'
import {
  PENDING_SUBMISSION_FLOWS,
  clearPendingSubmission,
  readPendingSubmission,
  resolvePendingSubmissionOutcome,
  type PendingSubmissionFlow,
  type PendingSubmissionRecord,
} from '~/utils/pendingSubmissions'

/**
 * Cross-surface enforcement of the pending-submission quarantine.
 *
 * Each flow (batch cart, outgoing migration, inbound migration) reconciles
 * its own durable record before retrying itself — but an ambiguous
 * submission must also block the *equivalent operation executed through a
 * different surface*: clearing an ambiguously-submitted batch and re-running
 * the borrow through the direct form, or re-adding a quarantined direct
 * migration to the cart. This gate runs inside every plan executor, before
 * anything reaches a wallet, and checks every flow's record for the
 * attempting wallet and chain.
 */

/**
 * The batch cart registers this so a landed batch record discovered from
 * another surface can retire/reset the exact entries it tracks (the cart's
 * own reconcile can never run for an emptied cart — executeBatch early-returns
 * on zero entries). The handler must release the record, invalidate any
 * standing review, and retire or reset the covered entries.
 */
export type LandedBatchSubmissionHandler = (record: PendingSubmissionRecord) => void

let landedBatchSubmissionHandler: LandedBatchSubmissionHandler | undefined

export const registerLandedBatchSubmissionHandler = (handler: LandedBatchSubmissionHandler) => {
  landedBatchSubmissionHandler = handler
}

const conflictingSubmissionError = (flow: PendingSubmissionFlow, record: PendingSubmissionRecord) => {
  const label = flow === 'batch' ? 'batch' : 'migration'
  if (record.phase === 'armed') {
    return new Error(`A previous ${label} submission was handed to the wallet but no transaction id came back, so it cannot be verified automatically. Check the wallet's pending activity and let it resolve before sending new transactions.`)
  }
  return new Error(`A previous ${label} submission from this wallet may still confirm on-chain and could not be verified yet. Wait a moment and try again — it is re-checked before anything new is sent.`)
}

export const assertNoConflictingPendingSubmission = async (input: {
  owner: Address
  chainId: number
  provider: ReceiptClientLike | undefined
  connector?: WalletConnectorLike
  getSafeWalletProvider: (connector?: WalletConnectorLike) => Promise<WalletProviderLike | undefined>
  safeStatusTimeoutMs?: number
}): Promise<void> => {
  const owner = getAddress(input.owner)
  for (const flow of PENDING_SUBMISSION_FLOWS) {
    const record = readPendingSubmission(flow, owner, input.chainId)
    if (!record) continue
    const outcome = await resolvePendingSubmissionOutcome(record, {
      provider: input.provider,
      getSafeWalletProvider: input.getSafeWalletProvider,
      connector: input.connector,
      safeStatusTimeoutMs: input.safeStatusTimeoutMs ?? 8_000,
    })
    if (outcome === 'not-landed') {
      // Definitively cancelled/reverted — nothing this attempt sends can
      // duplicate it.
      clearPendingSubmission(flow, record.owner, record.chainId)
      continue
    }
    if (outcome === 'unknown') {
      throw conflictingSubmissionError(flow, record)
    }
    // Landed: on-chain state moved under whatever this attempt reviewed.
    if (flow === 'batch') {
      if (landedBatchSubmissionHandler) {
        landedBatchSubmissionHandler(record)
        throw new Error('A previous batch submission confirmed on-chain and the batch cart was reconciled. Review your positions before sending new transactions.')
      }
      // No cart is alive to retire the covered entries — keep the record so
      // the cart reconciles it when it next runs.
      throw new Error('A previous batch submission confirmed on-chain. Open the batch cart to reconcile it before sending new transactions.')
    }
    clearPendingSubmission(flow, record.owner, record.chainId)
    throw new Error('A previous migration submission from this wallet confirmed on-chain. Review your positions before continuing — on-chain state changed since this action was prepared.')
  }
}
