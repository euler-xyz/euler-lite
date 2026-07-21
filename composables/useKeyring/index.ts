import { type Ref, ref, watch, onUnmounted } from 'vue'
import { useChainId } from '@wagmi/vue'
import { zeroAddress, type Address } from 'viem'
import {
  KeyringConnect,
  type CredentialData,
  type ExtensionSDKConfig,
  type ExtensionState,
} from '@keyringnetwork/keyring-connect-sdk'
import { keyringHookTargetAbi } from '~/abis/keyring'
import { isVaultKeyring } from '~/utils/eulerLabelsUtils'
import { getPublicClient } from '~/utils/public-client'
import { logWarn } from '~/utils/errorHandling'
import { getVaultHookTarget } from '~/utils/vault-hooks'

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

export const isCredentialForContext = (
  credential: CredentialData | null | undefined,
  trader: string | undefined,
  policyId: number | undefined,
  chainId: number | undefined,
): credential is CredentialData => Boolean(
  credential
  && trader
  && credential.trader?.toLowerCase() === trader.toLowerCase()
  && credential.policyId === policyId
  && credential.chainId === chainId,
)

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
      authorizationList: undefined,
    }) as T
  }
  catch (err) {
    logWarn(`useKeyring: Failed to read ${functionName} from hookTarget ${hookTarget}`, err)
    return undefined
  }
}

export const useKeyring = (vaultAddress: string | Ref<string>) => {
  const addressRef = typeof vaultAddress === 'string' ? ref(vaultAddress) : vaultAddress
  const { address: userAddress } = useWagmi()
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
  const isCheckingStatus = ref(false)
  const statusMessage = ref<string>()

  let unsubscribeExtension: (() => void) | null = null

  const isKeyringVault = computed(() => isVaultKeyring(addressRef.value))

  const hookTarget = computed((): Address | undefined => {
    if (!isKeyringVault.value) return undefined
    const vault = getVault(addressRef.value)
    if (!vault) return undefined
    const ht = getVaultHookTarget(vault as never) as Address
    return ht !== zeroAddress ? ht : undefined
  })

  const isVerificationRequired = computed(() =>
    isKeyringVault.value
    && Boolean(userAddress.value)
    && !hasValidCredential.value
    && flowState.value !== KeyringFlowState.Idle
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
    flowState.value = KeyringFlowState.Loading
    error.value = undefined
    statusMessage.value = undefined
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
          authorizationList: undefined,
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
              authorizationList: undefined,
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
      if (isCredentialForContext(cred, userAddress.value, policyId.value, chainId.value)) {
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
    error.value = undefined
    statusMessage.value = undefined

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

  const stopStatusPolling = () => {
    if (unsubscribeExtension) {
      unsubscribeExtension()
      unsubscribeExtension = null
    }
  }

  const handleExtensionState = async (state: ExtensionState | null, manualCheck = false) => {
    if (!state) {
      credentialData.value = null
      flowState.value = KeyringFlowState.Install
      statusMessage.value = undefined
      stopStatusPolling()
      return
    }

    const cred = state.credentialData
    if (cred) {
      if (isCredentialForContext(cred, userAddress.value, policyId.value, chainId.value)) {
        credentialData.value = cred
        flowState.value = KeyringFlowState.Ready
        statusMessage.value = undefined
      }
      else {
        credentialData.value = null
        flowState.value = KeyringFlowState.Start
        statusMessage.value = 'Restart verification for the connected wallet, policy, and network.'
      }
      stopStatusPolling()
      return
    }

    if (state.status === 'error' || state.status === 'prove_error') {
      credentialData.value = null
      flowState.value = KeyringFlowState.Error
      error.value = state.error || 'Keyring verification failed'
      statusMessage.value = undefined
      stopStatusPolling()
      return
    }

    const extensionUserMatches = state.user?.wallet_address?.toLowerCase() === userAddress.value?.toLowerCase()
    if (extensionUserMatches && state.user?.credential_status === 'valid') {
      await checkCredential()
      if (flowState.value === KeyringFlowState.Idle || flowState.value === KeyringFlowState.Ready) {
        stopStatusPolling()
      }
      return
    }

    if (state.status === 'proving') {
      flowState.value = KeyringFlowState.Progress
      statusMessage.value = 'Verification is still in progress in the Keyring extension.'
      return
    }

    if (manualCheck) {
      flowState.value = KeyringFlowState.Start
      statusMessage.value = 'Verification is not complete yet. Continue in the Keyring extension.'
      stopStatusPolling()
    }
  }

  const startStatusPolling = () => {
    stopStatusPolling()
    unsubscribeExtension = KeyringConnect.subscribeToExtensionState((state) => {
      void handleExtensionState(state)
    })
  }

  const checkStatus = async () => {
    isCheckingStatus.value = true
    try {
      const state = await KeyringConnect.getExtensionState()
      await handleExtensionState(state, true)
    }
    catch (err) {
      logWarn('useKeyring: Failed to check extension status', err)
      flowState.value = KeyringFlowState.Error
      error.value = 'Failed to check Keyring extension status'
      statusMessage.value = undefined
    }
    finally {
      isCheckingStatus.value = false
    }
  }

  const cancelVerification = () => {
    stopStatusPolling()
    flowState.value = KeyringFlowState.Start
    credentialData.value = null
    error.value = undefined
    statusMessage.value = undefined
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
      if (!isKeyringVault.value || !userAddress.value) {
        flowState.value = KeyringFlowState.Idle
      }
      else if (hookTarget.value) {
        void checkCredential()
      }
      else {
        flowState.value = KeyringFlowState.Loading
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
    hookTarget,
    credentialData,
    flowState,
    error,
    isCheckingStatus,
    statusMessage,
    launchExtension,
    checkStatus,
    cancelVerification,
  }
}
