import { computed, isRef, watch, onUnmounted, provide, reactive, type Ref } from 'vue'
import { useChainId } from '@wagmi/vue'
import type { Address } from 'viem'
import { isCredentialUnexpired, useKeyring } from '~/composables/useKeyring'
import { useTosGuard } from '~/composables/guards/useTosGuard'
import { useUnverifiedVaultGuard } from '~/composables/guards/useUnverifiedVaultGuard'
import {
  clearOperationMeta,
  registerOperationBlocker,
  registerOperationPolicyCheck,
  setOperationMeta,
  unregisterOperationBlocker,
  unregisterOperationPolicyCheck,
} from '~/utils/operationGuardRegistry'
import { clearSdkKeyringCredential, setSdkKeyringCredential } from '~/utils/sdk-keyring'
import { isVaultKeyring } from '~/utils/eulerLabelsUtils'
import { getVaultOperationGeoBlockReason } from '~/composables/useGeoBlock'
import { getEulerLabelsVersion } from '~/composables/useEulerLabels'

export interface OperationGuardOptions {
  /** Exit-only actions such as lending withdrawals and debt repayment remain
   * available even when regional policy blocks new or increased exposure. */
  enforceGeo?: boolean
  /** Exit-only actions do not require acknowledging the source vault again. */
  enforceUnverified?: boolean
}

let operationGuardInstanceSequence = 0

export const useOperationGuard = (
  vaultAddresses: Ref<(string | undefined)[]> | (string | undefined)[],
  options: OperationGuardOptions = {},
) => {
  const { address: userAddress } = useWagmi()
  const chainId = useChainId()
  const { registryVersion } = useVaultRegistry()
  const geoBlockerKey = `geo:${++operationGuardInstanceSequence}`
  const policyCheckKey = `policy:${operationGuardInstanceSequence}`

  const addresses = computed((): string[] => {
    const raw = isRef(vaultAddresses) ? vaultAddresses.value : vaultAddresses
    return raw.filter((addr): addr is string => Boolean(addr))
  })

  // --- TOS guard (global, not vault-specific) ---
  const tosGuard = useTosGuard()

  // --- Unverified vault guard ---
  const unverifiedGuard = options.enforceUnverified !== false
    ? useUnverifiedVaultGuard(addresses)
    : undefined

  // --- Geo guard ---
  const geoBlockReason = computed(() => {
    if (options.enforceGeo === false) return undefined
    // Geo resolution consults both the labels snapshot and lazily populated
    // vault metadata. Track their versions explicitly so an initially allowed
    // result cannot remain cached after either source finishes loading.
    getEulerLabelsVersion()
    void registryVersion.value
    return getVaultOperationGeoBlockReason(addresses.value)
  })
  watch(geoBlockReason, (reason) => {
    if (reason) registerOperationBlocker(geoBlockerKey, reason)
    else unregisterOperationBlocker(geoBlockerKey)
  }, { immediate: true })

  // --- Keyring guard ---
  const keyringVaultAddress = computed(() =>
    addresses.value.find(addr => isVaultKeyring(addr)) ?? '',
  )

  const keyring = useKeyring(keyringVaultAddress)

  const needsVerification = computed(() => keyring.isVerificationRequired.value)

  // This callback deliberately reads the source refs directly. Captured batch
  // and CoW operations retain it after this component's reactive scope stops.
  const getCurrentPolicyBlockReason = (): string | undefined => {
    const tosReason = tosGuard?.getBlockReason?.()
    if (tosReason) return tosReason

    if (options.enforceGeo !== false) {
      getEulerLabelsVersion()
      void registryVersion.value
      const geoReason = getVaultOperationGeoBlockReason(addresses.value)
      if (geoReason) return geoReason
    }

    const unverifiedReason = unverifiedGuard?.getBlockReason?.()
    if (unverifiedReason) return unverifiedReason
    // The source component may have unmounted, which stops useKeyring's expiry
    // timer. Evaluate the retained credential against wall-clock time at every
    // final policy boundary so it cannot remain valid indefinitely.
    if (
      keyringVaultAddress.value
      && keyring.credentialData.value
      && !isCredentialUnexpired(keyring.credentialData.value)
    ) return 'Identity verification required'
    return keyring.isVerificationRequired.value ? 'Identity verification required' : undefined
  }

  registerOperationPolicyCheck(policyCheckKey, getCurrentPolicyBlockReason)

  // Provide keyring state to descendant components (VaultFormSubmit)
  provide('keyring-guard', reactive({
    needsVerification,
    isExpired: keyring.isExpired,
    flowState: keyring.flowState,
    credentialData: keyring.credentialData,
    isCheckingStatus: keyring.isCheckingStatus,
    statusMessage: keyring.statusMessage,
    error: keyring.error,
    launchExtension: keyring.launchExtension,
    retryVerification: keyring.retryVerification,
    checkStatus: keyring.checkStatus,
    cancelVerification: keyring.cancelVerification,
  }))

  // Publish verified credentials to the SDK keyring plugin store. The SDK
  // reads this store and injects createCredential calls during plan construction.
  watch(
    [
      () => keyring.credentialData.value,
      () => keyring.hookTarget.value,
      () => keyring.policyId.value,
      () => keyring.keyringContractAddress.value,
      userAddress,
      chainId,
      () => keyring.rpcUrl.value,
    ],
    (_next, previous) => {
      const [prevCred, prevHookTarget, prevPolicyId, _prevKeyringAddress, prevUser, prevChainId] = previous ?? []
      if (prevCred && prevHookTarget && prevPolicyId !== undefined && prevUser && prevChainId) {
        clearSdkKeyringCredential({
          chainId: prevChainId as number,
          account: prevUser as Address,
          hookTarget: prevHookTarget as Address,
          policyId: prevPolicyId as number,
        })
        clearOperationMeta('keyring')
      }

      const cred = keyring.credentialData.value
      const hookTarget = keyring.hookTarget.value
      const policyId = keyring.policyId.value
      const keyringContractAddress = keyring.keyringContractAddress.value
      const user = userAddress.value
      const currentRpcUrl = keyring.rpcUrl.value

      if (cred && hookTarget && policyId !== undefined && keyringContractAddress && user && chainId.value && currentRpcUrl) {
        setSdkKeyringCredential({
          chainId: chainId.value,
          account: user as Address,
          hookTarget,
          policyId,
          keyringContractAddress,
          rpcUrl: currentRpcUrl,
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
    unregisterOperationBlocker(geoBlockerKey)
    unregisterOperationPolicyCheck(policyCheckKey)
  })
}
