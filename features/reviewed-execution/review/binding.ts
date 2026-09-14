import type { Hash } from 'viem'
import { canonicalDigest, deepFreezeSerializable, type CanonicalValue } from '../domain/canonical'
import type { ReviewBinding } from '../domain/reviewed-execution'
import type { OperationIntent } from '../domain/intents'

/**
 * Bind the existing handcrafted presentation to one execution without making
 * it executable. See docs/transaction-building.md#user-facing-review-compatibility.
 */
export const createReviewBinding = ({
  reviewId,
  intents,
  presentationKind,
  presentationInputs,
}: {
  reviewId: Hash
  intents: readonly OperationIntent[]
  presentationKind: string
  presentationInputs: CanonicalValue
}): Readonly<ReviewBinding> => {
  const binding: ReviewBinding = {
    schemaVersion: 1,
    reviewId,
    intentRevisions: intents.map(intent => ({ intentId: intent.intentId, revision: intent.revision })),
    presentationKind,
    presentationDigest: canonicalDigest('operation-review-presentation-v1', presentationInputs),
  }
  return deepFreezeSerializable(binding) as Readonly<ReviewBinding>
}
