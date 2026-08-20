import type { Hash } from 'viem'
import { canonicalDigest, deepFreezeSerializable, type CanonicalValue } from '../domain/canonical'
import type { OperationReviewBinding } from '../domain/ceremony'
import type { OperationIntent } from '../domain/intents'

/**
 * Bind the existing handcrafted presentation to one ceremony without making
 * it executable. See docs/transaction-building.md#user-facing-review-compatibility.
 */
export const createOperationReviewBinding = ({
  ceremonyId,
  intents,
  presentationKind,
  presentationInputs,
}: {
  ceremonyId: Hash
  intents: readonly OperationIntent[]
  presentationKind: string
  presentationInputs: CanonicalValue
}): Readonly<OperationReviewBinding> => {
  const binding: OperationReviewBinding = {
    schemaVersion: 1,
    ceremonyId,
    intentRevisions: intents.map(intent => ({ intentId: intent.intentId, revision: intent.revision })),
    presentationKind,
    presentationDigest: canonicalDigest('operation-review-presentation-v1', presentationInputs),
  }
  return deepFreezeSerializable(binding) as Readonly<OperationReviewBinding>
}
