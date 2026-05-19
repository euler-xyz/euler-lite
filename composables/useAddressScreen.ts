import { useDisconnect } from '@wagmi/vue'
import { useModal } from '~/components/ui/composables/useModal'
import { BlockedAddressModal } from '#components'
import { detectVpn, resetVpnCache } from '~/services/vpn'
import { resetCountryCache } from '~/services/country'
import { screenAddress } from '~/services/trm'
import { getDefaultPageRoute } from '~/entities/menu'

// Module-scoped so every useAddressScreen() consumer sees the same screening
// verdict — otherwise each composable instance would carry its own pending
// state and downstream gates (useWagmi.isAddressScreened) could disagree.
const blockedAddress = ref<string | null>(null)
const isScreening = ref(false)
const screenedAddress = ref<string | null>(null)
let screeningGeneration = 0

const normalizeAddress = (address?: string | null) => address?.toLowerCase() ?? ''

export const useAddressScreen = () => {
  const modal = useModal()
  const { disconnect } = useDisconnect()
  const router = useRouter()

  const { enableEarnPage, enableLendPage, enableExplorePage } = useDeployConfig()
  const defaultPageRoute = getDefaultPageRoute(enableEarnPage, enableLendPage, enableExplorePage)

  const showBlockedModal = (address: string) => {
    blockedAddress.value = address
    modal.open(BlockedAddressModal, {
      props: {
        address,
        onClose: () => {
          modal.close()
          blockedAddress.value = null
          router.push({ name: defaultPageRoute })
        },
      },
    })
  }

  const screenConnectedAddress = async (address: string): Promise<boolean> => {
    if (!address) {
      return false
    }

    const gen = ++screeningGeneration
    screenedAddress.value = null
    isScreening.value = true
    try {
      const vpnIsUsed = await detectVpn()
      if (gen !== screeningGeneration) return false

      const isRestricted = await screenAddress(address, vpnIsUsed)
      if (gen !== screeningGeneration) return false

      if (isRestricted) {
        await disconnect()
        if (gen !== screeningGeneration) return false
        showBlockedModal(address)
        return true
      }
      screenedAddress.value = address
      return false
    }
    finally {
      if (gen === screeningGeneration) {
        isScreening.value = false
      }
    }
  }

  const isAddressScreened = (address?: string | null) =>
    Boolean(address && normalizeAddress(screenedAddress.value) === normalizeAddress(address))

  const resetScreeningCache = () => {
    screeningGeneration++
    screenedAddress.value = null
    isScreening.value = false
    resetVpnCache()
    resetCountryCache()
  }

  return {
    isScreening,
    blockedAddress,
    screenedAddress,
    isAddressScreened,
    screenConnectedAddress,
    resetScreeningCache,
  }
}
