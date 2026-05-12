import { registerOperationBlocker, unregisterOperationBlocker } from '~/utils/operationGuardRegistry'
import { SANCTIONED_COUNTRIES } from '~/entities/country-constants'

const sameAddress = (a?: string | null, b?: string | null): boolean =>
  Boolean(a && b && a.toLowerCase() === b.toLowerCase())

export const useComplianceBlockers = () => {
  if (!import.meta.client) return

  const { address, isConnected } = useWagmi()
  const { country } = useGeoBlock()
  const { screeningStatus, screenedAddress } = useAddressScreen()

  watch(
    [isConnected, address, screeningStatus, screenedAddress],
    () => {
      if (!isConnected.value || !address.value) {
        unregisterOperationBlocker('wallet-screening')
        return
      }

      if (screeningStatus.value === 'allowed' && sameAddress(screenedAddress.value, address.value)) {
        unregisterOperationBlocker('wallet-screening')
        return
      }

      if (screeningStatus.value === 'blocked' && sameAddress(screenedAddress.value, address.value)) {
        registerOperationBlocker('wallet-screening', 'Wallet screening failed')
        return
      }

      registerOperationBlocker('wallet-screening', 'Checking wallet compliance')
    },
    { immediate: true },
  )

  watch(
    country,
    (value) => {
      if (value === undefined) {
        registerOperationBlocker('geo', 'Checking location restrictions')
      }
      else if (value === null) {
        registerOperationBlocker('geo', 'Unable to verify location')
      }
      else if (SANCTIONED_COUNTRIES.includes(value.toUpperCase())) {
        registerOperationBlocker('geo', 'Location is restricted')
      }
      else {
        unregisterOperationBlocker('geo')
      }
    },
    { immediate: true },
  )

  onUnmounted(() => {
    unregisterOperationBlocker('wallet-screening')
    unregisterOperationBlocker('geo')
  })
}
