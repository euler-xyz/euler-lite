import { computed, isRef, watch, onUnmounted, provide, reactive, type Ref } from 'vue'
import { useChainId } from '@wagmi/vue'
import type { Address } from 'viem'
import { useKeyring, KeyringFlowState } from '~/composables/useKeyring'
import { useTosGuard } from '~/composables/guards/useTosGuard'
import { useUnverifiedVaultGuard } from '~/composables/guards/useUnverifiedVaultGuard'
import { registerOperationGuard, unregisterOperationGuard, registerOperationBlocker, unregisterOperationBlocker } from '~/utils/operationGuardRegistry'
import { injectKeyringCredential } from '~/utils/keyring-injection'
import { isVaultKeyring } from '~/utils/eulerLabelsUtils'

export const useOperationGuard = (vaultAddresses: Ref<(string | undefined)[]> | (string | undefined)[]) => {
  const { address: userAddress } = useWagmi()
  const chainId = useChainId()

  const addresses = computed((): string[] => {
    const raw = isRef(vaultAddresses) ? vaultAddresses.value : vaultAddresses
    return raw.filter((addr): addr is string => Boolean(addr))
  })

  // --- TOS guard (global, not vault-specific) ---
  useTosGuard()

  // --- Unverified vault guard ---
  useUnverifiedVaultGuard(addresses)

  // --- Keyring guard ---
  const keyringVaultAddress = computed(() =>
    addresses.value.find(addr => isVaultKeyring(addr)) ?? '',
  )

  const keyring = useKeyring(keyringVaultAddress)

  const needsVerification = computed(() =>
    keyring.isKeyringVault.value
    && !keyring.hasValidCredential.value
    && keyring.flowState.value !== KeyringFlowState.Idle
    && keyring.flowState.value !== KeyringFlowState.Ready,
  )

  // Provide keyring state to descendant components (VaultFormSubmit)
  provide('keyring-guard', reactive({
    needsVerification,
    isExpired: keyring.isExpired,
    flowState: keyring.flowState,
    credentialData: keyring.credentialData,
    launchExtension: keyring.launchExtension,
    checkStatus: keyring.checkStatus,
    cancelVerification: keyring.cancelVerification,
  }))

  // Register/unregister the plan transformer in the guard registry
  watch(
    [() => keyring.credentialData.value, () => keyring.keyringContractAddress.value, userAddress],
    () => {
      const cred = keyring.credentialData.value
      const kca = keyring.keyringContractAddress.value
      const user = userAddress.value

      if (cred && kca && user) {
        registerOperationGuard(
          'keyring',
          plan => injectKeyringCredential(plan, kca, cred, user as Address),
          { credentialCost: cred.cost, chainId: chainId.value, priority: 10 },
        )
      }
      else {
        unregisterOperationGuard('keyring')
      }
    },
    { immediate: true },
  )

  // Register/unregister blocker so VaultFormSubmit disables itself
  watch(
    needsVerification,
    (blocked) => {
      if (blocked) {
        registerOperationBlocker('keyring', 'Identity verification required')
      }
      else {
        unregisterOperationBlocker('keyring')
      }
    },
    { immediate: true },
  )

  onUnmounted(() => {
    unregisterOperationGuard('keyring')
    unregisterOperationBlocker('keyring')
  })
}
