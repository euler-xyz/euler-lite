import { computed, ref } from 'vue'
import { getTxErrorMessage } from '~/utils/tx-errors'
import { useToast } from '~/components/ui/composables/useToast'

// Module-scoped: detachment outlives the modal that started the execution.
const detachedPendingCount = ref(0)
const attachedSubmittingCount = ref(0)

/**
 * Lets a review modal be closed while a Safe proposal is still collecting
 * co-signer signatures, without losing track of the execution.
 *
 * A detached execution surfaces its completion as a toast (success or the
 * decoded failure) and suppresses the flow's post-transaction navigation —
 * by the time a proposal confirms, the user may be deep in another flow.
 * Data freshness needs nothing extra: `finalizeExecution` in useEulerTx
 * already invalidates queries and refreshes the portfolio on success.
 *
 * Suppression must not swallow the navigation of a normally-attended
 * submission that succeeds while some other detached proposal is pending, so
 * modals register their in-flight (modal-open) submissions via
 * `trackAttached`: a success can only belong to a detached execution when
 * something detached is pending AND no attached submission is in flight.
 */
export const useSafeExecutionDetachment = () => {
  const toast = useToast()

  /** Register a modal-open submission. Returns an idempotent release. */
  const trackAttached = () => {
    attachedSubmittingCount.value++
    let released = false
    return () => {
      if (released) return
      released = true
      attachedSubmittingCount.value = Math.max(0, attachedSubmittingCount.value - 1)
    }
  }

  /** Hand an in-flight execution over to background completion toasts. */
  const detach = (execution: Promise<unknown>, options?: { successMessage?: string }) => {
    detachedPendingCount.value++
    execution
      .then(() => {
        toast.success(options?.successMessage ?? 'Safe transaction confirmed')
      })
      .catch(async (err: unknown) => {
        toast.error(await getTxErrorMessage(err))
      })
      .finally(() => {
        detachedPendingCount.value = Math.max(0, detachedPendingCount.value - 1)
      })
  }

  const shouldSuppressPostTxNavigation = () =>
    detachedPendingCount.value > 0 && attachedSubmittingCount.value === 0

  return {
    trackAttached,
    detach,
    shouldSuppressPostTxNavigation,
    hasDetachedPending: computed(() => detachedPendingCount.value > 0),
  }
}
