import { computed, provide, reactive, ref, watch, onUnmounted, type ComputedRef, type Ref } from 'vue'
import { normalizeAddress } from '~/utils/normalizeAddress'
import { registerOperationBlocker, unregisterOperationBlocker } from '~/utils/operationGuardRegistry'

export interface UnverifiedVaultGuardState {
  isAcknowledgmentRequired: boolean
  acknowledgeRisk: () => void
}

interface UnverifiedVaultGuardContext {
  account: Ref<string | undefined>
  chainId: Ref<number | undefined>
}

export const useUnverifiedVaultGuard = (
  vaultAddresses: ComputedRef<string[]>,
  context?: UnverifiedVaultGuardContext,
) => {
  const { isKnownEscrowAddress } = useVaultRegistry()
  const { verifiedVaultAddresses, earnVaults } = useEulerLabels()

  const acknowledgedContextKey = ref('')

  const contextKey = computed(() => {
    const addresses = [...new Set(vaultAddresses.value.map(normalizeAddress))].sort()
    const account = context?.account.value ? normalizeAddress(context.account.value) : ''
    return JSON.stringify([context?.chainId.value ?? null, account, addresses])
  })

  const hasUnverifiedVault = computed(() =>
    vaultAddresses.value.some((addr) => {
      const normalized = normalizeAddress(addr)
      return !verifiedVaultAddresses.value.includes(normalized)
        && !earnVaults.value.includes(normalized)
        && !isKnownEscrowAddress(normalized)
    }),
  )

  const isAcknowledgmentRequired = computed(() =>
    hasUnverifiedVault.value && acknowledgedContextKey.value !== contextKey.value,
  )

  const acknowledgeRisk = () => {
    acknowledgedContextKey.value = contextKey.value
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
