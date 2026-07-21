import { type Ref, ref, watch, onUnmounted } from 'vue'
import { useChainId } from '@wagmi/vue'
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

// Read a hook-target view value, trying each getter name in order. Euler's
// native HookTargetAccessControlKeyring exposes public-immutable getters
// (`policyId()`, `keyring()`), while integrator-supplied variants such as
// HookTargetAccessControlKeyringUnwind expose `getPolicyId()` / `getKeyring()`.
// Returns the first name that resolves. If every candidate reverts, logs the
// underlying error loudly: a silently-swallowed read here is exactly what made
// this failure undiagnosable (policyId stayed undefined and Start Verification
// no-op'd with no console output).
// Exported for unit testing the native/integrator getter-name fallback.
export const readHookTargetValue = async <T>(
  rpcUrl: string,
  hookTarget: Address,
  functionNames: readonly string[],
): Promise<T | undefined> => {
  const client = getPublicClient(rpcUrl)
  let lastError: unknown
  for (const functionName of functionNames) {
    try {
      return await client.readContract({
        address: hookTarget,
        abi: keyringHookTargetAbi,
        functionName: functionName as 'policyId' | 'getPolicyId' | 'keyring' | 'getKeyring' | 'checkKeyringCredentialOrWildCard',
        authorizationList: undefined,
      }) as T
    }
    catch (error) {
      // Getter absent on this hook target implementation — try the next name.
      lastError = error
    }
  }
  logWarn(
    `useKeyring: hook target ${hookTarget} responds to none of [${functionNames.join(', ')}] — `
    + 'keyring policy could not be resolved and verification cannot start',
    lastError,
    { severity: 'error' },
  )
  return undefined
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

  let statusCheckInterval: ReturnType<typeof setInterval> | null = null
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

      // Read policyId and keyring contract address from the hook target,
      // trying native (policyId/keyring) then integrator (getPolicyId/getKeyring)
      // getter names. policyId may decode as uint256 on the integrator variant,
      // so coerce to a Number to match the rest of the flow (extension config,
      // credential matching) which expects a plain number.
      const [rawPolicyId, kca, hasCredential] = await Promise.all([
        readHookTargetValue<number | bigint>(rpcUrl.value, ht, ['policyId', 'getPolicyId']),
        readHookTargetValue<Address>(rpcUrl.value, ht, ['keyring', 'getKeyring']),
        client.readContract({
          address: ht,
          abi: keyringHookTargetAbi,
          functionName: 'checkKeyringCredentialOrWildCard',
          authorizationList: undefined,
          args: [user],
        }).catch(() => false) as Promise<boolean>,
      ])

      const pid = rawPolicyId === undefined ? undefined : Number(rawPolicyId)
      policyId.value = pid
      keyringContractAddress.value = kca
      hasValidCredential.value = hasCredential === true

      if (hasValidCredential.value) {
        flowState.value = KeyringFlowState.Idle
        credentialData.value = null
      }
      else if (pid === undefined || !kca) {
        // Neither policyId()/getPolicyId() nor keyring()/getKeyring() resolved on
        // this hook target, so we cannot build a verification request or inject a
        // credential. Surface an error instead of a dead "Start Verification"
        // button (readHookTargetValue has already logged the underlying revert).
        flowState.value = KeyringFlowState.Error
        error.value = 'Could not read the Keyring policy for this vault. Verification is unavailable — please try again later or contact support.'
      }
      else {
        // Surface an expired credential (if any) so the alert copy can explain it.
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
      // The extension echoes the trader address in its own casing — compare
      // case-insensitively so a casing difference doesn't force a re-auth.
      if (
        cred
        && cred.trader?.toLowerCase() === userAddress.value?.toLowerCase()
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
    if (!userAddress.value || !chainId.value || policyId.value === undefined) {
      // Previously a silent no-op — the reason "Start Verification" appeared to
      // do nothing. Log which prerequisite is missing so it is diagnosable.
      logWarn(
        'useKeyring: cannot start verification, prerequisites missing',
        `userAddress=${Boolean(userAddress.value)} chainId=${chainId.value ?? 'none'} policyId=${policyId.value ?? 'undefined'}`,
      )
      return
    }

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
    hookTarget,
    credentialData,
    flowState,
    error,
    launchExtension,
    checkStatus,
    cancelVerification,
  }
}
