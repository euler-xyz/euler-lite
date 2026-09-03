import type { Hash, StateOverride } from 'viem'
import type { TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { OperationReviewModal, ReviewedOperationModal } from '#components'
import { useModal } from '~/components/ui/composables/useModal'
import type { OperationIntent } from '~/features/reviewed-execution/domain/intents'
import type { SubmissionResult } from '~/features/reviewed-execution/coordinator/coordinator'

export interface ReviewPresentation extends Record<string, unknown> {
  asset: { address: string, symbol: string, decimals: number, name?: string }
  amount: number | string
}

export interface OpenExecutionReviewOptions {
  presentationKind: string
  review: ReviewPresentation
  tenderlyPrepared?: TransactionPlanPrepared
  tenderlyStateOverrides?: StateOverride
  onConfirmed?: (result: SubmissionResult) => void | Promise<void>
  onResult?: (result: SubmissionResult) => void | Promise<void>
  onSucceeded?: (result: SubmissionResult) => void | Promise<void>
  onFailed?: (cause: unknown) => void | Promise<void>
}

const clonePresentationValue = (value: unknown): unknown => {
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) return Object.freeze(value.map(clonePresentationValue))
  const captured: Record<string, unknown> = {}
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined || typeof entry === 'function' || key === 'onConfirm') continue
    captured[key] = clonePresentationValue(entry)
  }
  return Object.freeze(captured)
}

/** Snapshot presentation data synchronously at the review-launch boundary. */
export const captureReviewPresentation = (review: ReviewPresentation): ReviewPresentation =>
  clonePresentationValue(review) as ReviewPresentation

/**
 * The only operation-review launcher for in-scope transaction plans. It binds
 * the unchanged handcrafted presentation to an opaque reviewed execution identity; the
 * modal receives no execution callback. See
 * docs/transaction-building.md#user-facing-review-compatibility.
 */
export const useExecutionReview = () => {
  const modal = useModal()
  const execution = useReviewedExecution()
  const { isSpyMode } = useEffectiveAddress()

  const open = async (
    intents: readonly OperationIntent[],
    options: OpenExecutionReviewOptions,
  ): Promise<{ reviewId: Hash, reviewDigest: Hash }> => {
    // Callers may keep editing reactive form state while preparation awaits.
    // Only this synchronous copy is bound to and rendered by the review.
    const capturedOptions: OpenExecutionReviewOptions = {
      ...options,
      review: captureReviewPresentation(options.review),
    }
    if (isSpyMode.value) {
      const prepared = await execution.prepareReadOnly(intents, {
        presentationKind: capturedOptions.presentationKind,
        presentationInputs: capturedOptions.review,
      })
      modal.open(OperationReviewModal, {
        props: {
          ...capturedOptions.review,
          plan: undefined,
          prepared: prepared.prepared,
          calldataPrepared: prepared.prepared,
          tenderlyPrepared: capturedOptions.tenderlyPrepared ?? prepared.prepared,
          tenderlyStateOverrides: capturedOptions.tenderlyStateOverrides,
          reviewedAccount: prepared.execution.requestSet.wallet.account,
          reviewedWalletKind: prepared.execution.requestSet.wallet.walletKind,
          reviewedRequests: prepared.execution.requestSet.requests,
          reviewedSignatureSlots: prepared.execution.requestSet.signatureSlots,
          readOnly: true,
        },
      })
      return {
        reviewId: prepared.execution.reviewId,
        reviewDigest: prepared.execution.reviewDigest,
      }
    }
    const prepared = await execution.prepare(intents, {
      presentationKind: capturedOptions.presentationKind,
      presentationInputs: capturedOptions.review,
    })
    const reviewId = prepared.execution.reviewId
    const reviewDigest = prepared.execution.reviewDigest
    modal.open(ReviewedOperationModal, {
      props: {
        reviewId,
        reviewDigest,
        review: {
          ...capturedOptions.review,
          plan: undefined,
          prepared: prepared.prepared,
          calldataPrepared: prepared.prepared,
          tenderlyPrepared: capturedOptions.tenderlyPrepared ?? prepared.prepared,
          tenderlyStateOverrides: capturedOptions.tenderlyStateOverrides,
        },
        onConfirmed: capturedOptions.onConfirmed,
        onResult: capturedOptions.onResult,
        onSucceeded: async (result: SubmissionResult) => {
          await capturedOptions.onSucceeded?.(result)
        },
        onFailed: capturedOptions.onFailed,
      },
    })
    return { reviewId, reviewDigest }
  }

  return { open }
}
