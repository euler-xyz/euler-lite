import { useModal } from '~/components/ui/composables/useModal'
import { MODAL_CLOSE_REDIRECT_DELAY_MS } from '~/entities/tuning-constants'
import type { TrackedExecutionScope } from '~/composables/useSafeExecutionDetachment'

interface FinalizeOptions {
  onAfterClose?: () => void | Promise<void>
  /** Execution scope from the confirming modal; absent = untracked flow. */
  scope?: TrackedExecutionScope
}

export const useTxFinalization = () => {
  const router = useRouter()
  const modal = useModal()

  const finalizeTxAndRedirect = async (options: FinalizeOptions = {}) => {
    // Reaching the finalize point is the success signal a detached
    // completion toast keys on — flows swallow their own errors, so a bare
    // promise resolution is not evidence of confirmation. Bound to THIS
    // execution's record: a late tail can never mark a successor.
    options.scope?.markSucceeded()
    if (options.scope?.suppressPostTxUi()) {
      // A detached Safe proposal confirmed after its modal was closed — the
      // user may be mid-flow elsewhere, so completion surfaces as a toast
      // only. Flow cleanup still runs.
      if (options.onAfterClose) await options.onAfterClose()
      return
    }
    modal.close()
    if (options.onAfterClose) await options.onAfterClose()
    setTimeout(() => router.replace('/portfolio'), MODAL_CLOSE_REDIRECT_DELAY_MS)
  }

  /** UI-only completion for the reviewed execution adapter, which owns modal closure. */
  const finalizeExecutionUi = async (onAfterClose?: () => void | Promise<void>) => {
    if (onAfterClose) await onAfterClose()
    setTimeout(() => router.replace('/portfolio'), MODAL_CLOSE_REDIRECT_DELAY_MS)
  }

  return { finalizeTxAndRedirect, finalizeExecutionUi }
}
