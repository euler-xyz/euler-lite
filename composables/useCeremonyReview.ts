import type { Hash } from 'viem'
import { CeremonyOperationReviewModal } from '#components'
import { useModal } from '~/components/ui/composables/useModal'
import type { OperationIntent } from '~/features/transaction-ceremony/domain/intents'
import type { TransactionPlan } from '@eulerxyz/euler-v2-sdk'
import { getEagerPlanIntents } from '~/features/transaction-ceremony/planning/eager-plan-intents'

export interface CeremonyReviewPresentation extends Record<string, unknown> {
  asset: { address: string, symbol: string, decimals: number, name?: string }
  amount: number | string
}

export interface OpenCeremonyReviewOptions {
  presentationKind: string
  review: CeremonyReviewPresentation
  onSucceeded?: () => void | Promise<void>
  onFailed?: (cause: unknown) => void | Promise<void>
}

/**
 * The only operation-review launcher for in-scope transaction plans. It binds
 * the unchanged handcrafted presentation to an opaque ceremony identity; the
 * modal receives no execution callback. See
 * docs/transaction-building.md#user-facing-review-compatibility.
 */
export const useCeremonyReview = () => {
  const modal = useModal()
  const ceremony = useTransactionCeremony()

  const open = async (
    intents: readonly OperationIntent[],
    options: OpenCeremonyReviewOptions,
  ): Promise<{ ceremonyId: Hash, consentDigest: Hash }> => {
    const prepared = await ceremony.prepare(intents, {
      presentationKind: options.presentationKind,
      presentationInputs: options.review,
    })
    const ceremonyId = prepared.ceremony.ceremonyId
    const consentDigest = prepared.ceremony.consentDigest
    modal.open(CeremonyOperationReviewModal, {
      props: {
        ceremonyId,
        consentDigest,
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
    return { ceremonyId, consentDigest }
  }

  const openEagerPlan = (plan: TransactionPlan, options: OpenCeremonyReviewOptions) =>
    open(getEagerPlanIntents(plan), options)

  return { open, openEagerPlan }
}
