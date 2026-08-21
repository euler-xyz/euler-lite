import type { Hash } from 'viem'
import { ReviewedOperationModal } from '#components'
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
  onResult?: (result: SubmissionResult) => void | Promise<void>
  onSucceeded?: (result: SubmissionResult) => void | Promise<void>
  onFailed?: (cause: unknown) => void | Promise<void>
}

/**
 * The only operation-review launcher for in-scope transaction plans. It binds
 * the unchanged handcrafted presentation to an opaque reviewed execution identity; the
 * modal receives no execution callback. See
 * docs/transaction-building.md#user-facing-review-compatibility.
 */
export const useExecutionReview = () => {
  const modal = useModal()
  const execution = useReviewedExecution()

  const open = async (
    intents: readonly OperationIntent[],
    options: OpenExecutionReviewOptions,
  ): Promise<{ reviewId: Hash, reviewDigest: Hash }> => {
    const prepared = await execution.prepare(intents, {
      presentationKind: options.presentationKind,
      presentationInputs: options.review,
    })
    const reviewId = prepared.execution.reviewId
    const reviewDigest = prepared.execution.reviewDigest
    modal.open(ReviewedOperationModal, {
      props: {
        reviewId,
        reviewDigest,
        review: {
          ...options.review,
          plan: undefined,
          prepared: prepared.prepared,
          calldataPrepared: prepared.prepared,
          tenderlyPrepared: prepared.prepared,
        },
        onResult: options.onResult,
        onSucceeded: async (result: SubmissionResult) => {
          await options.onSucceeded?.(result)
        },
        onFailed: options.onFailed,
      },
    })
    return { reviewId, reviewDigest }
  }

  return { open }
}
