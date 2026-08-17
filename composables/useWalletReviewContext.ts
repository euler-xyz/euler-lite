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

  watch(
    [account, chainId, isSubmitting],
    ([currentAccount, currentChainId, submitting]) => {
      if (isInvalidated.value || submitting) return

      const change = getWalletExecutionContextChange({
        expectedAccount,
        expectedChainId,
        currentAccount,
        currentChainId,
      })
      if (!change) return

      // Disable synchronously while the modal starts its leave transition, so
      // the stale review cannot be submitted during the closing animation.
      isInvalidated.value = true
      onInvalidated(change)
    },
    { flush: 'sync' },
  )

  return {
    isReviewWalletContextInvalidated: readonly(isInvalidated),
  }
}
