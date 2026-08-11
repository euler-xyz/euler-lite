import { computed, ref } from 'vue'
import { getTxErrorMessage } from '~/utils/tx-errors'
import { useToast } from '~/components/ui/composables/useToast'

interface TrackedExecution {
  id: number
  detached: boolean
  succeeded: boolean
  safeAtSubmit: boolean
}

// Single slot, module-scoped. Detachment is execution-scoped by cardinality:
// at most one tracked execution exists at a time, and while a detached one is
// pending every new confirm is gated off — so any post-transaction
// navigation or success marker observed during a detached window can only
// belong to that execution.
let nextExecutionId = 1
const currentExecution = ref<TrackedExecution | null>(null)

/**
 * The flow's success tail reached its finalize point. Recorded on the
 * tracked execution so a detached completion can distinguish "confirmed"
 * from "resolved because the flow swallowed its error".
 */
export const markTrackedExecutionSucceeded = () => {
  if (currentExecution.value) {
    currentExecution.value = { ...currentExecution.value, succeeded: true }
  }
}

/**
 * True while a detached Safe execution is pending — post-transaction
 * navigation must be suppressed (the user may be mid-flow elsewhere) and new
 * submissions are gated until it resolves.
 */
export const shouldSuppressPostTxNavigation = () =>
  currentExecution.value?.detached === true

export interface TrackedExecutionHandle {
  /** Wallet classification latched at submission time. */
  safeAtSubmit: boolean
  /** Hand the execution over to background completion toasts. */
  detach: (execution: Promise<unknown>, options?: { successMessage?: string }) => void
  /** End attached tracking (promise settled while the modal stayed open). */
  release: () => void
}

/**
 * Lets a review modal be closed while a Safe proposal is still collecting
 * co-signer signatures, without losing track of the execution.
 *
 * A detached execution surfaces its completion as a toast: success when the
 * flow's finalize point marked it, the decoded failure when it rejected, and
 * an explicit warning when it resolved without ever reaching finalize —
 * flows commonly catch their own errors and resolve, so a bare resolution
 * must never be reported as confirmation. Data freshness needs nothing
 * extra: `finalizeExecution` in useEulerTx already invalidates queries and
 * refreshes the portfolio on success.
 */
export const useSafeExecutionDetachment = () => {
  const toast = useToast()

  /**
   * Track a submission. Returns null while ANY tracked execution is live —
   * detached or attended. Overwriting an attended slot would orphan its
   * handle (its detach/release would no-op) and let its finalize point mark
   * success on the wrong execution, so exclusivity is required for
   * attribution, not just during detached windows.
   */
  const beginTrackedExecution = (options: { safeAtSubmit: boolean }): TrackedExecutionHandle | null => {
    if (currentExecution.value) return null
    const id = nextExecutionId++
    currentExecution.value = {
      id,
      detached: false,
      succeeded: false,
      safeAtSubmit: options.safeAtSubmit,
    }

    return {
      safeAtSubmit: options.safeAtSubmit,
      detach: (execution, detachOptions) => {
        if (currentExecution.value?.id !== id) return
        currentExecution.value = { ...currentExecution.value, detached: true }
        execution
          .then(() => {
            if (currentExecution.value?.id === id && currentExecution.value.succeeded) {
              toast.success(detachOptions?.successMessage ?? 'Safe transaction confirmed')
            }
            else {
              // Resolved without reaching the flow's finalize point — the
              // flow swallowed a failure. Never report that as confirmed.
              toast.warning('Safe transaction did not complete — check your Safe for details')
            }
          })
          .catch(async (err: unknown) => {
            toast.error(await getTxErrorMessage(err))
          })
          .finally(() => {
            if (currentExecution.value?.id === id) currentExecution.value = null
          })
      },
      release: () => {
        if (currentExecution.value?.id === id && !currentExecution.value.detached) {
          currentExecution.value = null
        }
      },
    }
  }

  return {
    beginTrackedExecution,
    markTrackedExecutionSucceeded,
    shouldSuppressPostTxNavigation,
    hasPendingDetachedExecution: computed(() => currentExecution.value?.detached === true),
  }
}
