import { computed, isRef, watch, onUnmounted, provide, reactive, type Ref } from 'vue'
import { useChainId } from '@wagmi/vue'
import type { Address } from 'viem'
import { useKeyring, KeyringFlowState } from '~/composables/useKeyring'
import { useTosGuard } from '~/composables/guards/useTosGuard'
import { useUnverifiedVaultGuard } from '~/composables/guards/useUnverifiedVaultGuard'
import { clearOperationMeta, registerOperationBlocker, setOperationMeta, unregisterOperationBlocker } from '~/utils/operationGuardRegistry'
import { clearSdkKeyringCredential, setSdkKeyringCredential } from '~/utils/sdk-keyring'
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

  // Publish verified credentials to the SDK keyring plugin store. The SDK
  // injects createCredential calls during plan construction; Lite no longer
  // mutates plans for keyring.
  watch(
    [() => keyring.credentialData.value, () => keyring.hookTarget.value, () => keyring.policyId.value, userAddress],
    (_next, previous) => {
      const [prevCred, prevHookTarget, prevPolicyId, prevUser] = previous ?? []
      if (prevCred && prevHookTarget && prevPolicyId !== undefined && prevUser && chainId.value) {
        clearSdkKeyringCredential({
          chainId: chainId.value,
          account: prevUser as Address,
          hookTarget: prevHookTarget as Address,
          policyId: prevPolicyId as number,
        })
        clearOperationMeta('keyring')
      }

      const cred = keyring.credentialData.value
      const hookTarget = keyring.hookTarget.value
      const policyId = keyring.policyId.value
      const user = userAddress.value

      if (cred && hookTarget && policyId !== undefined && user && chainId.value) {
        setSdkKeyringCredential({
          chainId: chainId.value,
          account: user as Address,
          hookTarget,
          policyId,
          credential: cred,
        })
        setOperationMeta('keyring', {
          credentialCost: Number(cred.cost),
          chainId: chainId.value,
        })
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
    clearOperationMeta('keyring')
    unregisterOperationBlocker('keyring')
  })
}
