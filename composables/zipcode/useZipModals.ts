import {
  ZipDepositFlow,
  ZipRedemptionFlow,
  ZipClaimFlow,
  ZipFastExitTeaserModal,
} from '#components'
import { useModal } from '~/components/ui/composables/useModal'

// Thin wrapper over the Euler modal system so pages/components open Zip Code
// flows without importing the flow components directly. Flows render inside
// the shared <UiModals/> mounted in app.vue (kept outside the isZipcode branch).

export const useZipModals = () => {
  const modal = useModal()

  return {
    openDepositFlow: () => modal.open(ZipDepositFlow),
    openRedemptionFlow: () => modal.open(ZipRedemptionFlow),
    openClaimFlow: () => modal.open(ZipClaimFlow),
    openFastExitTeaser: () => modal.open(ZipFastExitTeaserModal),
  }
}
