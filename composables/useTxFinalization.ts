import { useModal } from '~/components/ui/composables/useModal'
import { MODAL_CLOSE_REDIRECT_DELAY_MS } from '~/entities/tuning-constants'

interface FinalizeOptions {
  onAfterClose?: () => void | Promise<void>
}

export const useTxFinalization = () => {
  const router = useRouter()
  const modal = useModal()
  const { markTrackedExecutionSucceeded, shouldSuppressPostTxNavigation } = useSafeExecutionDetachment()

  const finalizeTxAndRedirect = async (options: FinalizeOptions = {}) => {
    // Reaching the finalize point is the success signal a detached
    // completion toast keys on — flows swallow their own errors, so a bare
    // promise resolution is not evidence of confirmation.
    markTrackedExecutionSucceeded()
    if (shouldSuppressPostTxNavigation()) {
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

  return { finalizeTxAndRedirect }
}
