import type { Hash } from 'viem'
import type { EoaRequest } from '../domain/reviewed-execution'
import type { EoaAdapterClient } from './eoa'
import type { SafeAdapterClient } from './safe'
import { getSafeAtomicCapability, reconcileSafeTransactionExecution, sendSafeAtomicCalls, waitForSafeTransactionExecution, type WalletProviderLike } from '~/utils/safeWalletTransactions'
import {
  attachPendingSafeCallsId,
  clearPendingSafeReviewedSubmission,
  createSafeReservationId,
  findPendingSafeReviewedSubmission,
  reservePendingSafeReviewedSubmission,
} from '~/utils/pending-safe-reviewed-submission'
import { acquireSafeReviewedSubmissionLock, withSafeReviewedSubmissionLock } from '~/utils/safe-reviewed-submission-lock'

interface PublicTransactionClient {
  getTransactionReceipt(args: { hash: Hash }): Promise<{ transactionHash: Hash, status: 'success' | 'reverted', blockNumber: bigint }>
}

export const createAppEoaClients = ({
  send,
}: {
  send(request: EoaRequest): Promise<Hash>
}): { adapter: EoaAdapterClient } => ({
  adapter: {
    sendTransaction: send,
  },
})

/** Use the established current-session Safe polling and receipt resolution. */
export const createAppSafeClients = ({
  provider,
  publicClient,
  onReconciled,
}: {
  provider: WalletProviderLike
  publicClient: PublicTransactionClient
  onReconciled?: () => void | Promise<void>
}): { adapter: SafeAdapterClient } => {
  const activeHandoffs = new Map<string, { storage: Storage, release: () => void }>()

  const getStorage = (): Storage => {
    try {
      if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
    }
    catch { /* handled below */ }
    throw new Error('Durable Safe submission storage is unavailable. Verify the Safe before retrying.')
  }

  const releaseActiveHandoff = (reservationId: string) => {
    const active = activeHandoffs.get(reservationId)
    if (!active) return
    activeHandoffs.delete(reservationId)
    active.release()
  }

  return {
    adapter: {
      assertAtomicCapability: async (envelope) => {
        await getSafeAtomicCapability(provider, envelope.from, envelope.chainId)
      },
      reserveSubmission: async (identity) => {
        const release = await acquireSafeReviewedSubmissionLock()
        try {
          const storage = getStorage()
          const pending = findPendingSafeReviewedSubmission(storage, identity.account, identity.chainId)
          if (pending?.callsId) {
            const reconciliation = await reconcileSafeTransactionExecution({
              callsId: pending.callsId,
              walletProvider: provider,
              publicClient: publicClient as never,
            })
            if (reconciliation.state === 'success' || reconciliation.state === 'reverted'
              || reconciliation.state === 'cancelled' || reconciliation.state === 'failed') {
              clearPendingSafeReviewedSubmission(storage, pending.reservationId)
              if (reconciliation.state === 'success' || reconciliation.state === 'reverted') await onReconciled?.()
              if (reconciliation.state === 'success') {
                throw new Error('The previous Safe proposal succeeded. Refresh, prepare, and review the operation again before submitting.')
              }
            }
            else {
              throw new Error('A previous Safe proposal is still pending or could not be reconciled. Check Safe before retrying.')
            }
          }
          else if (pending) {
            throw new Error('A previous Safe wallet handoff has no recoverable calls ID. Confirm in Safe that no proposal exists before clearing the lock.')
          }

          const reservationId = createSafeReservationId()
          reservePendingSafeReviewedSubmission(storage, {
            reservationId,
            reviewId: identity.reviewId,
            reviewDigest: identity.reviewDigest,
            requestDigest: identity.requestDigest,
            account: identity.account,
            chainId: identity.chainId,
            createdAt: Date.now(),
          })
          activeHandoffs.set(reservationId, { storage, release })
          return reservationId
        }
        catch (error) {
          release()
          throw error
        }
      },
      recordCallsId: async (reservationId, callsId) => {
        const active = activeHandoffs.get(reservationId)
        if (active) {
          try {
            attachPendingSafeCallsId(active.storage, reservationId, callsId)
          }
          finally {
            releaseActiveHandoff(reservationId)
          }
          return
        }
        await withSafeReviewedSubmissionLock(() => attachPendingSafeCallsId(getStorage(), reservationId, callsId))
      },
      releaseSubmission: async (reservationId) => {
        releaseActiveHandoff(reservationId)
      },
      clearSubmission: async (reservationId) => {
        const active = activeHandoffs.get(reservationId)
        if (active) {
          try {
            clearPendingSafeReviewedSubmission(active.storage, reservationId)
          }
          finally {
            releaseActiveHandoff(reservationId)
          }
          return
        }
        await withSafeReviewedSubmissionLock(() => clearPendingSafeReviewedSubmission(getStorage(), reservationId))
      },
      sendCalls: envelope => sendSafeAtomicCalls(provider, envelope),
      waitForExecution: async (callsId) => {
        const execution = await waitForSafeTransactionExecution({
          callsId,
          walletProvider: provider,
          publicClient: publicClient as never,
          requireAtomic: true,
        })
        return {
          executionHash: execution.hash,
          receiptStatus: execution.receipt.status,
          confirmedBlockNumber: execution.receipt.blockNumber,
          atomic: execution.atomic === true,
        }
      },
    },
  }
}
