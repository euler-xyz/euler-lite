import type { Hash } from 'viem'
import { ReviewedOperationModal } from '#components'
import { useModal } from '~/components/ui/composables/useModal'
import type { OperationIntent } from '~/features/reviewed-execution/domain/intents'

export interface ReviewPresentation extends Record<string, unknown> {
  asset: { address: string, symbol: string, decimals: number, name?: string }
  amount: number | string
}

export interface OpenExecutionReviewOptions {
  presentationKind: string
  review: ReviewPresentation
  onSucceeded?: () => void | Promise<void>
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
        onSucceeded: async () => {
          await options.onSucceeded?.()
        },
        onFailed: options.onFailed,
      },
    })
    return { reviewId, reviewDigest }
  }

  return { open }
}
