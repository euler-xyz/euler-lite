import { computed, provide, reactive, ref, watch, onUnmounted, type ComputedRef } from 'vue'
import type { EulerEarn, EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { getEulerLabelsVersion } from '~/composables/useEulerLabels'
import { registerOperationBlocker, unregisterOperationBlocker } from '~/utils/operationGuardRegistry'

export interface UnverifiedVaultGuardState {
  isAcknowledgmentRequired: boolean
  acknowledgeRisk: () => void
}

let unverifiedVaultGuardInstanceSequence = 0

export const useUnverifiedVaultGuard = (vaultAddresses: ComputedRef<string[]>) => {
  const { get, getOrFetch, registryVersion } = useVaultRegistry()
  const { chainId } = useEulerAddresses()
  const {
    isVaultGovernorVerified,
    isSecuritizeGovernorVerified,
    isEarnVaultOwnerVerified,
  } = useVaults()

  const sessionAccepted = ref(false)
  let resolutionGeneration = 0
  const blockerKey = `unverified-vault:${++unverifiedVaultGuardInstanceSequence}`

  watch([vaultAddresses, chainId], async ([addresses, activeChainId]) => {
    const generation = ++resolutionGeneration
    await Promise.all(addresses.map(address => getOrFetch(address)))
    if (generation !== resolutionGeneration || chainId.value !== activeChainId) return
    // Registry writes are already reactive. This branch intentionally has no
    // permissive fallback when a lookup fails or resolves on another chain.
  }, { immediate: true })

  const hasCanonicalVerification = (address: string): boolean => {
    const entry = get(address)
    if (!entry || !chainId.value || entry.vault.chainId !== chainId.value) return false

    switch (entry.type) {
      case 'earn':
        return isEarnVaultOwnerVerified(entry.vault as EulerEarn)
      case 'securitize':
        return isSecuritizeGovernorVerified(entry.vault as SecuritizeCollateralVault)
      case 'evk':
        return isVaultGovernorVerified(entry.vault as EVault)
      default:
        return false
    }
  }

  const hasUnverifiedVault = computed(() => {
    // Track both live registry replacement and label refreshes before applying
    // the canonical authority rule for the resolved vault type.
    void registryVersion.value
    getEulerLabelsVersion()
    return vaultAddresses.value.some(address => !hasCanonicalVerification(address))
  })

  const isAcknowledgmentRequired = computed(() =>
    hasUnverifiedVault.value && !sessionAccepted.value,
  )

  const acknowledgeRisk = () => {
    sessionAccepted.value = true
  }

  watch(isAcknowledgmentRequired, (required) => {
    if (required) {
      registerOperationBlocker(blockerKey, 'Unverified vault risk acknowledgment required')
    }
    else {
      unregisterOperationBlocker(blockerKey)
    }
  }, { immediate: true })

  onUnmounted(() => {
    unregisterOperationBlocker(blockerKey)
  })

  provide('unverified-vault-guard', reactive({
    isAcknowledgmentRequired,
    acknowledgeRisk,
  }))
}
