import { useDisconnect } from '@wagmi/vue'
import { useModal } from '~/components/ui/composables/useModal'
import { BlockedAddressModal } from '#components'
import { resetCountryCache } from '~/services/country'
import { screenAddress } from '~/services/trm'
import { getDefaultPageRoute } from '~/entities/menu'

export type AddressScreeningStatus = 'idle' | 'pending' | 'allowed' | 'blocked'

const blockedAddress = ref<string | null>(null)
const screenedAddress = ref<string | null>(null)
const screeningStatus = ref<AddressScreeningStatus>('idle')
const isScreening = computed(() => screeningStatus.value === 'pending')
let screeningGeneration = 0

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
    screenedAddress.value = address
    screeningStatus.value = 'pending'
    const isRestricted = await screenAddress(address)
    if (gen !== screeningGeneration) return false

    if (isRestricted) {
      screeningStatus.value = 'blocked'
      await disconnect()
      showBlockedModal(address)
      return true
    }
    screeningStatus.value = 'allowed'
    return false
  }

  const resetScreeningCache = () => {
    screeningGeneration++
    screenedAddress.value = null
    blockedAddress.value = null
    screeningStatus.value = 'idle'
    resetCountryCache()
  }

  return {
    isScreening,
    screeningStatus,
    screenedAddress,
    blockedAddress,
    screenConnectedAddress,
    resetScreeningCache,
  }
}
