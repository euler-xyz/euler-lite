import { readonly, ref, watch, type Ref } from 'vue'
import { getWalletExecutionContextChange, type WalletExecutionContextChange } from '~/utils/walletExecutionContext'

export const useWalletReviewContext = ({
  account,
  chainId,
  isSubmitting,
  onInvalidated,
}: {
  account: Readonly<Ref<string | undefined>>
  chainId: Readonly<Ref<number | undefined>>
  isSubmitting: Readonly<Ref<boolean>>
  onInvalidated: (change: WalletExecutionContextChange) => void
}) => {
  const expectedAccount = account.value
  const expectedChainId = chainId.value
  const isInvalidated = ref(false)
  let pendingChange: WalletExecutionContextChange | undefined
  let invalidationNotified = false

  watch(
    [account, chainId, isSubmitting],
    ([currentAccount, currentChainId, submitting]) => {
      if (invalidationNotified) return

      const change = pendingChange ?? getWalletExecutionContextChange({
        expectedAccount,
        expectedChainId,
        currentAccount,
        currentChainId,
      })
      if (!change) return

      if (!isInvalidated.value) {
        // Latch the first drift even during submission. The wallet may return
        // to the reviewed account/network before the promise settles, but the
        // review still crossed an unreviewed execution context and must never
        // become confirmable again.
        pendingChange = change
        isInvalidated.value = true
      }
      if (submitting) return

      // Closing is deferred while a submission is active, but disabling is
      // synchronous so a round-trip cannot revive the stale review.
      invalidationNotified = true
      onInvalidated(change)
    },
    { flush: 'sync' },
  )

  return {
    isReviewWalletContextInvalidated: readonly(isInvalidated),
  }
}
