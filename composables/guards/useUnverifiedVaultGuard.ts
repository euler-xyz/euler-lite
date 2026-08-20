import { computed, provide, reactive, ref, watch, onUnmounted, type ComputedRef } from 'vue'
import { normalizeAddress } from '~/utils/normalizeAddress'
import { registerOperationBlocker, unregisterOperationBlocker } from '~/utils/operationGuardRegistry'
import { recordUnverifiedVaultAcknowledgement } from '~/features/transaction-ceremony/policy/acknowledgements'

export interface UnverifiedVaultGuardState {
  isAcknowledgmentRequired: boolean
  acknowledgeRisk: () => void
}

export const useUnverifiedVaultGuard = (vaultAddresses: ComputedRef<string[]>) => {
  const { isKnownEscrowAddress } = useVaultRegistry()
  const { verifiedVaultAddresses, earnVaults } = useEulerLabels()

  const sessionAccepted = ref(false)

  const hasUnverifiedVault = computed(() =>
    vaultAddresses.value.some((addr) => {
      const normalized = normalizeAddress(addr)
      return !verifiedVaultAddresses.value.includes(normalized)
        && !earnVaults.value.includes(normalized)
        && !isKnownEscrowAddress(normalized)
    }),
  )

  const isAcknowledgmentRequired = computed(() =>
    hasUnverifiedVault.value && !sessionAccepted.value,
  )

  const acknowledgeRisk = () => {
    recordUnverifiedVaultAcknowledgement(vaultAddresses.value)
    sessionAccepted.value = true
  }

  watch(isAcknowledgmentRequired, (required) => {
    if (required) {
      registerOperationBlocker('unverified-vault', 'Unverified vault risk acknowledgment required')
    }
    else {
      unregisterOperationBlocker('unverified-vault')
    }
  }, { immediate: true })

  onUnmounted(() => {
    unregisterOperationBlocker('unverified-vault')
  })

  provide('unverified-vault-guard', reactive({
    isAcknowledgmentRequired,
    acknowledgeRisk,
  }))
}
