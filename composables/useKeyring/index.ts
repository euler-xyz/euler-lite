import { type Ref, ref, watch, onUnmounted } from 'vue'
import { useAccount, useChainId } from '@wagmi/vue'
import { zeroAddress, type Address } from 'viem'
import {
  KeyringConnect,
  type CredentialData,
  type ExtensionSDKConfig,
} from '@keyringnetwork/keyring-connect-sdk'
import { keyringHookTargetAbi } from '~/abis/keyring'
import { isVaultKeyring } from '~/utils/eulerLabelsUtils'
import { getPublicClient } from '~/utils/public-client'
import { logWarn } from '~/utils/errorHandling'

export { type CredentialData } from '@keyringnetwork/keyring-connect-sdk'

export enum KeyringFlowState {
  Idle = 'idle',
  Loading = 'loading',
  Install = 'install',
  Start = 'start',
  Progress = 'progress',
  Ready = 'ready',
  Error = 'error',
}

const readHookTargetField = async <T>(
  rpcUrl: string,
  hookTarget: Address,
  functionName: string,
): Promise<T | undefined> => {
  try {
    const client = getPublicClient(rpcUrl)
    return await client.readContract({
      address: hookTarget,
      abi: keyringHookTargetAbi,
      functionName: functionName as 'policyId' | 'keyring' | 'checkKeyringCredentialOrWildCard',
    }) as T
  }
  catch (err) {
    logWarn(`useKeyring: Failed to read ${functionName} from hookTarget ${hookTarget}`, err)
    return undefined
  }
}

export const useKeyring = (vaultAddress: string | Ref<string>) => {
  const addressRef = typeof vaultAddress === 'string' ? ref(vaultAddress) : vaultAddress
  const { address: userAddress } = useAccount()
  const chainId = useChainId()
  const { getVault } = useVaultRegistry()
  const { rpcUrl } = useRpcClient()

  // State
  const isLoading = ref(false)
  const hasValidCredential = ref(false)
  const policyId = ref<number>()
  const keyringContractAddress = ref<Address>()
  const expiration = ref<bigint>()
  const credentialData = ref<CredentialData | null>(null)
  const flowState = ref<KeyringFlowState>(KeyringFlowState.Idle)
  const error = ref<string>()

  let statusCheckInterval: ReturnType<typeof setInterval> | null = null
  let unsubscribeExtension: (() => void) | null = null

  const isKeyringVault = computed(() => isVaultKeyring(addressRef.value))

  const hookTarget = computed((): Address | undefined => {
    if (!isKeyringVault.value) return undefined
    const vault = getVault(addressRef.value)
    if (!vault || !('hookTarget' in vault)) return undefined
    const ht = (vault as { hookTarget: string }).hookTarget as Address
    return ht !== zeroAddress ? ht : undefined
  })

  const isVerificationRequired = computed(() =>
    isKeyringVault.value
    && !isLoading.value
    && !hasValidCredential.value
    && flowState.value !== KeyringFlowState.Ready,
  )

  const isExpired = computed(() =>
    isKeyringVault.value
    && !hasValidCredential.value
    && expiration.value !== undefined
    && expiration.value > 0n,
  )

  const checkCredential = async () => {
    const ht = hookTarget.value
    const user = userAddress.value
    if (!ht || !user || !rpcUrl.value) return

    isLoading.value = true
    try {
      const client = getPublicClient(rpcUrl.value)

      // Read policyId and keyring contract address from hookTarget
      const [pid, kca, hasCredential] = await Promise.all([
        readHookTargetField<number>(rpcUrl.value, ht, 'policyId'),
        readHookTargetField<Address>(rpcUrl.value, ht, 'keyring'),
        client.readContract({
          address: ht,
          abi: keyringHookTargetAbi,
          functionName: 'checkKeyringCredentialOrWildCard',
          args: [user],
        }).catch(() => false) as Promise<boolean>,
      ])

      policyId.value = pid
      keyringContractAddress.value = kca
      hasValidCredential.value = hasCredential === true

      if (hasValidCredential.value) {
        flowState.value = KeyringFlowState.Idle
        credentialData.value = null
      }
      else {
        // Check if there's an expired credential
        if (kca && pid !== undefined) {
          try {
            const { keyringContractAbi: kAbi } = await import('~/abis/keyring')
            const exp = await client.readContract({
              address: kca,
              abi: kAbi,
              functionName: 'entityExp',
              args: [BigInt(pid), user],
            })
            expiration.value = exp as bigint
          }
          catch {
            expiration.value = undefined
          }
        }
        flowState.value = KeyringFlowState.Loading
        await initExtensionState()
      }
    }
    catch (err) {
      logWarn('useKeyring: Failed to check credential', err)
      flowState.value = KeyringFlowState.Error
      error.value = 'Failed to check keyring credential'
    }
    finally {
      isLoading.value = false
    }
  }

  const initExtensionState = async () => {
    try {
      const installed = await KeyringConnect.isKeyringConnectInstalled()
      if (!installed) {
        flowState.value = KeyringFlowState.Install
        return
      }

      const state = await KeyringConnect.getExtensionState()
      const cred = state?.credentialData
      if (
        cred
        && cred.trader === userAddress.value
        && cred.policyId === policyId.value
        && cred.chainId === chainId.value
      ) {
        credentialData.value = cred
        flowState.value = KeyringFlowState.Ready
      }
      else {
        flowState.value = KeyringFlowState.Start
      }
    }
    catch {
      flowState.value = KeyringFlowState.Start
    }
  }

  const launchExtension = async () => {
    if (!userAddress.value || !chainId.value || policyId.value === undefined) return

    const config: ExtensionSDKConfig = {
      app_url: window.location.origin,
      name: 'Euler Finance',
      logo_url: `${window.location.origin}/logo.svg`,
      policy_id: policyId.value,
      credential_config: {
        chain_id: chainId.value,
        wallet_address: userAddress.value,
      },
    }

    flowState.value = KeyringFlowState.Progress
    credentialData.value = null

    try {
      await KeyringConnect.launchExtension(config)
      startStatusPolling()
    }
    catch (err) {
      logWarn('useKeyring: Failed to launch extension', err)
      flowState.value = KeyringFlowState.Error
      error.value = 'Failed to launch Keyring extension'
    }
  }

  const startStatusPolling = () => {
    stopStatusPolling()
    // Use subscribeToExtensionState if available, otherwise poll
    unsubscribeExtension = KeyringConnect.subscribeToExtensionState((state) => {
      if (!state) return
      if (state.credentialData) {
        credentialData.value = state.credentialData
        flowState.value = KeyringFlowState.Ready
        stopStatusPolling()
      }
      else if (state.user?.credential_status === 'valid') {
        hasValidCredential.value = true
        flowState.value = KeyringFlowState.Idle
        stopStatusPolling()
      }
    })
  }

  const stopStatusPolling = () => {
    if (statusCheckInterval) {
      clearInterval(statusCheckInterval)
      statusCheckInterval = null
    }
    if (unsubscribeExtension) {
      unsubscribeExtension()
      unsubscribeExtension = null
    }
  }

  const checkStatus = async () => {
    try {
      const state = await KeyringConnect.getExtensionState()
      if (state?.credentialData) {
        credentialData.value = state.credentialData
        flowState.value = KeyringFlowState.Ready
        stopStatusPolling()
      }
      else if (state?.user?.credential_status === 'valid') {
        hasValidCredential.value = true
        flowState.value = KeyringFlowState.Idle
        stopStatusPolling()
      }
    }
    catch (err) {
      logWarn('useKeyring: Failed to check extension status', err)
    }
  }

  const cancelVerification = () => {
    stopStatusPolling()
    flowState.value = KeyringFlowState.Start
    credentialData.value = null
  }

  // Re-check extension state when user returns to the tab (e.g. after installing the extension)
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible' && flowState.value === KeyringFlowState.Install) {
      initExtensionState()
    }
  }

  watch(
    () => isKeyringVault.value,
    (isKeyring) => {
      if (typeof document === 'undefined') return
      if (isKeyring) {
        document.addEventListener('visibilitychange', onVisibilityChange)
      }
      else {
        document.removeEventListener('visibilitychange', onVisibilityChange)
      }
    },
    { immediate: true },
  )

  // Watch for vault/user changes and re-check credential
  watch(
    [addressRef, userAddress, hookTarget, chainId],
    () => {
      credentialData.value = null
      hasValidCredential.value = false
      if (isKeyringVault.value && hookTarget.value && userAddress.value) {
        checkCredential()
      }
      else if (!isKeyringVault.value) {
        flowState.value = KeyringFlowState.Idle
      }
    },
    { immediate: true },
  )

  onUnmounted(() => {
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
    stopStatusPolling()
  })

  return {
    isKeyringVault,
    isLoading,
    isVerificationRequired,
    isExpired,
    hasValidCredential,
    expiration,
    policyId,
    keyringContractAddress,
    credentialData,
    flowState,
    error,
    launchExtension,
    checkStatus,
    cancelVerification,
  }
}
