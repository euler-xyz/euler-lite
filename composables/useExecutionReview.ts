import type { Hash, StateOverride } from 'viem'
import type { TransactionPlanPrepared } from '@eulerxyz/euler-v2-sdk'
import { OperationReviewModal, ReviewedOperationModal } from '#components'
import { useModal } from '~/components/ui/composables/useModal'
import type { OperationIntent } from '~/features/reviewed-execution/domain/intents'
import { deepFreezeSerializable } from '~/features/reviewed-execution/domain/canonical'
import { selectMatchingPreparedIntents } from '~/features/reviewed-execution/planning/requirements'
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

export interface CapturedExecutionReview {
  /** Immutable click-time intent set used for authoritative preparation. */
  intents: readonly OperationIntent[]
  /** True only when the warmed intent set was semantically identical. */
  usesPreparedIntents: boolean
  open: () => Promise<{ reviewId: Hash, reviewDigest: Hash }>
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

  const openCaptured = async (
    intents: readonly OperationIntent[],
    options: OpenExecutionReviewOptions,
  ): Promise<{ reviewId: Hash, reviewDigest: Hash }> => {
    if (isSpyMode.value) {
      const prepared = await execution.prepareReadOnly(intents, {
        presentationKind: options.presentationKind,
        presentationInputs: options.review,
      })
      modal.open(OperationReviewModal, {
        props: {
          ...options.review,
          plan: undefined,
          prepared: prepared.prepared,
          calldataPrepared: prepared.prepared,
          tenderlyPrepared: options.tenderlyPrepared ?? prepared.prepared,
          tenderlyStateOverrides: options.tenderlyStateOverrides,
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
          tenderlyPrepared: options.tenderlyPrepared ?? prepared.prepared,
          tenderlyStateOverrides: options.tenderlyStateOverrides,
        },
        onConfirmed: options.onConfirmed,
        onResult: options.onResult,
        onSucceeded: async (result: SubmissionResult) => {
          await options.onSucceeded?.(result)
        },
        onFailed: options.onFailed,
      },
    })
    return { reviewId, reviewDigest }
  }

  /**
   * Seal intent and presentation state synchronously at the trusted form-action
   * boundary. Warmed intent DTOs are retained only when their transaction
   * semantics exactly match the freshly captured click-time intents.
   */
  const capture = (
    currentIntents: readonly OperationIntent[],
    options: OpenExecutionReviewOptions,
    preparedIntents?: readonly OperationIntent[],
  ): CapturedExecutionReview => {
    const selectedIntents = selectMatchingPreparedIntents(preparedIntents, currentIntents)
    const intents = deepFreezeSerializable(selectedIntents) as readonly OperationIntent[]
    const capturedOptions: OpenExecutionReviewOptions = Object.freeze({
      ...options,
      review: captureReviewPresentation(options.review),
    })
    return Object.freeze({
      intents,
      usesPreparedIntents: preparedIntents !== undefined && selectedIntents === preparedIntents,
      open: () => openCaptured(intents, capturedOptions),
    })
  }

  return { capture }
}
