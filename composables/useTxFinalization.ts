import { useModal } from '~/components/ui/composables/useModal'
import { MODAL_CLOSE_REDIRECT_DELAY_MS } from '~/entities/tuning-constants'

interface FinalizeOptions {
  onAfterClose?: () => void | Promise<void>
}

export const useTxFinalization = () => {
  const router = useRouter()
  const modal = useModal()

  const finalizeTxAndRedirect = async (options: FinalizeOptions = {}) => {
    modal.close()
    if (options.onAfterClose) await options.onAfterClose()
    setTimeout(() => router.replace('/portfolio'), MODAL_CLOSE_REDIRECT_DELAY_MS)
  }

  return { finalizeTxAndRedirect }
}
