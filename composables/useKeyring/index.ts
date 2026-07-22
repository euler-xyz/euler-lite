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
import {
  readKeyringHookTargetValue,
  validateKeyringContractAddress,
  type KeyringHookGetterName,
} from '~/utils/keyring-hook-target'

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

interface KeyringContext {
  version: number
  vaultAddress: string
  hookTarget: Address
  userAddress: Address
  chainId: number
  rpcUrl: string
}

const unixTimeSeconds = () => Math.floor(Date.now() / 1000)

export const isCredentialUnexpired = (
  credential: CredentialData | null | undefined,
): credential is CredentialData => Boolean(
  credential
  && Number.isFinite(credential.validUntil)
  && credential.validUntil > unixTimeSeconds(),
)

const isCredentialIdentityForContext = (
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

export const isCredentialForContext = (
  credential: CredentialData | null | undefined,
  trader: string | undefined,
  policyId: number | undefined,
  chainId: number | undefined,
): credential is CredentialData =>
  isCredentialIdentityForContext(credential, trader, policyId, chainId)
  && isCredentialUnexpired(credential)

// Read a hook-target view value, trying each getter name in order. Euler's
// native HookTargetAccessControlKeyring exposes public-immutable getters
// (`policyId()`, `keyring()`), while integrator-supplied variants such as
// HookTargetAccessControlKeyringUnwind expose `getPolicyId()` / `getKeyring()`.
// Returns the first name that resolves and logs the final error when none do,
// allowing the verification flow to report unavailable hook metadata.
// Exported for unit testing the native/integrator getter-name fallback.
export const readHookTargetValue = async <T>(
  rpcUrl: string,
  hookTarget: Address,
  functionNames: readonly KeyringHookGetterName[],
): Promise<T | undefined> => {
  const client = getPublicClient(rpcUrl)
  try {
    return await readKeyringHookTargetValue<T>(client, hookTarget, functionNames)
  }
  catch (error) {
    logWarn(
      `useKeyring: hook target ${hookTarget} responds to none of [${functionNames.join(', ')}] — `
      + 'keyring policy could not be resolved and verification cannot start',
      error,
      { severity: 'error' },
    )
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
  let contextVersion = 0
  let credentialCheckVersion = 0
  let verificationAttempt = 0
  let extensionStateVersion = 0
  let credentialExpiryTimer: ReturnType<typeof setTimeout> | null = null
  let credentialExpiryVersion = 0
  let disposed = false

  const isKeyringVault = computed(() => isVaultKeyring(addressRef.value))

  const hookTarget = computed((): Address | undefined => {
    if (!isKeyringVault.value) return undefined
    const vault = getVault(addressRef.value)
    if (!vault) return undefined
    const ht = getVaultHookTarget(vault as never) as Address
    return ht !== zeroAddress ? ht : undefined
  })

  const captureContext = (): KeyringContext | undefined => {
    if (disposed) return undefined
    const currentHookTarget = hookTarget.value
    const currentUser = userAddress.value
    const currentChainId = chainId.value
    const currentRpcUrl = rpcUrl.value
    if (!currentHookTarget || !currentUser || !currentChainId || !currentRpcUrl) return undefined

    return {
      version: contextVersion,
      vaultAddress: addressRef.value.toLowerCase(),
      hookTarget: currentHookTarget,
      userAddress: currentUser,
      chainId: currentChainId,
      rpcUrl: currentRpcUrl,
    }
  }

  const isContextCurrent = (context: KeyringContext): boolean =>
    !disposed
    && context.version === contextVersion
    && addressRef.value.toLowerCase() === context.vaultAddress
    && hookTarget.value?.toLowerCase() === context.hookTarget.toLowerCase()
    && userAddress.value?.toLowerCase() === context.userAddress.toLowerCase()
    && chainId.value === context.chainId
    && rpcUrl.value === context.rpcUrl

  const isCheckCurrent = (context: KeyringContext, checkVersion: number): boolean =>
    isContextCurrent(context) && checkVersion === credentialCheckVersion

  const isAttemptCurrent = (context: KeyringContext, attempt: number): boolean =>
    isContextCurrent(context) && attempt === verificationAttempt

  const clearCredentialExpiryTimer = () => {
    credentialExpiryVersion += 1
    if (credentialExpiryTimer !== null) {
      clearTimeout(credentialExpiryTimer)
      credentialExpiryTimer = null
    }
  }

  const clearCredentialData = () => {
    clearCredentialExpiryTimer()
    credentialData.value = null
  }

  const scheduleCredentialExpiry = (credential: CredentialData, context: KeyringContext) => {
    clearCredentialExpiryTimer()
    const expiryVersion = credentialExpiryVersion
    const expiresAt = credential.validUntil * 1000

    const checkExpiry = () => {
      credentialExpiryTimer = null
      if (!isContextCurrent(context) || expiryVersion !== credentialExpiryVersion) return

      const remaining = expiresAt - Date.now()
      if (remaining > 0) {
        credentialExpiryTimer = setTimeout(checkExpiry, Math.min(remaining, 2_147_483_647))
        return
      }

      clearCredentialData()
      hasValidCredential.value = false
      flowState.value = KeyringFlowState.Start
      statusMessage.value = 'Your Keyring credential has expired. Restart verification to continue.'
    }

    checkExpiry()
  }

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

  const checkCredential = async (requestIsCurrent: () => boolean = () => true) => {
    const context = captureContext()
    if (!context) return
    const checkVersion = ++credentialCheckVersion
    const isCurrent = () => isCheckCurrent(context, checkVersion) && requestIsCurrent()

    isLoading.value = true
    flowState.value = KeyringFlowState.Loading
    error.value = undefined
    statusMessage.value = undefined
    try {
      const client = getPublicClient(context.rpcUrl)

      // Read policyId and keyring contract address from the hook target, trying
      // native (policyId/keyring) then integrator (getPolicyId/getKeyring) getter
      // names. Both policyId() and getPolicyId() are uint32, so viem returns a
      // number directly — no coercion needed.
      const [pid, rawKeyringAddress, hasCredential] = await Promise.all([
        readHookTargetValue<number>(context.rpcUrl, context.hookTarget, ['policyId', 'getPolicyId']),
        readHookTargetValue<Address>(context.rpcUrl, context.hookTarget, ['keyring', 'getKeyring']),
        client.readContract({
          address: context.hookTarget,
          abi: keyringHookTargetAbi,
          functionName: 'checkKeyringCredentialOrWildCard',
          authorizationList: undefined,
          args: [context.userAddress],
        }).catch(() => false) as Promise<boolean>,
      ])

      if (!isCurrent()) return

      policyId.value = pid
      hasValidCredential.value = hasCredential === true

      if (hasValidCredential.value) {
        keyringContractAddress.value = rawKeyringAddress
        expiration.value = undefined
        flowState.value = KeyringFlowState.Idle
        clearCredentialData()
        return
      }

      let validatedKeyringAddress: Address | undefined
      if (rawKeyringAddress) {
        try {
          validatedKeyringAddress = await validateKeyringContractAddress(client, rawKeyringAddress)
        }
        catch (validationError) {
          logWarn(
            `useKeyring: invalid Keyring credentials contract for hook target ${context.hookTarget}`,
            validationError,
            { severity: 'error' },
          )
        }
      }

      if (!isCurrent()) return
      keyringContractAddress.value = validatedKeyringAddress

      if (pid === undefined || !validatedKeyringAddress) {
        // Verification requires both the policy and validated Keyring contract
        // configured by this hook target.
        flowState.value = KeyringFlowState.Error
        error.value = 'Could not read the Keyring policy for this vault. Verification is unavailable — please try again later or contact support.'
      }
      else {
        // Surface an expired credential (if any) so the alert copy can explain it.
        try {
          const { keyringContractAbi: kAbi } = await import('~/abis/keyring')
          const exp = await client.readContract({
            address: validatedKeyringAddress,
            abi: kAbi,
            functionName: 'entityExp',
            authorizationList: undefined,
            args: [BigInt(pid), context.userAddress],
          })
          if (!isCurrent()) return
          expiration.value = exp as bigint
        }
        catch {
          if (!isCurrent()) return
          expiration.value = undefined
        }
        flowState.value = KeyringFlowState.Loading
        await initExtensionState(context, checkVersion, requestIsCurrent)
      }
    }
    catch (err) {
      if (!isCurrent()) return
      logWarn('useKeyring: Failed to check credential', err)
      flowState.value = KeyringFlowState.Error
      error.value = 'Failed to check keyring credential'
    }
    finally {
      if (isCheckCurrent(context, checkVersion)) {
        isLoading.value = false
      }
    }
  }

  const initExtensionState = async (
    context: KeyringContext,
    checkVersion = credentialCheckVersion,
    requestIsCurrent: () => boolean = () => true,
  ) => {
    const isCurrent = () => isCheckCurrent(context, checkVersion) && requestIsCurrent()
    try {
      const installed = await KeyringConnect.isKeyringConnectInstalled()
      if (!isCurrent()) return
      if (!installed) {
        flowState.value = KeyringFlowState.Install
        return
      }

      const state = await KeyringConnect.getExtensionState()
      if (!isCurrent()) return
      const cred = state?.credentialData
      if (isCredentialForContext(cred, context.userAddress, policyId.value, context.chainId)) {
        credentialData.value = cred
        scheduleCredentialExpiry(cred, context)
        flowState.value = KeyringFlowState.Ready
      }
      else {
        clearCredentialData()
        flowState.value = KeyringFlowState.Start
        if (isCredentialIdentityForContext(cred, context.userAddress, policyId.value, context.chainId)) {
          statusMessage.value = 'Your previous Keyring credential has expired. Restart verification to continue.'
        }
      }
    }
    catch {
      if (!isCurrent()) return
      flowState.value = KeyringFlowState.Start
    }
  }

  const launchExtension = async () => {
    const context = captureContext()
    const currentPolicyId = policyId.value
    const currentKeyringAddress = keyringContractAddress.value
    if (!context || currentPolicyId === undefined || !currentKeyringAddress) {
      logWarn(
        'useKeyring: cannot start verification, prerequisites missing',
        `context=${Boolean(context)} policyId=${currentPolicyId ?? 'undefined'} keyring=${currentKeyringAddress ?? 'undefined'}`,
      )
      return
    }

    const attempt = ++verificationAttempt

    const config: ExtensionSDKConfig = {
      app_url: window.location.origin,
      name: 'Euler Finance',
      logo_url: `${window.location.origin}/logo.svg`,
      policy_id: currentPolicyId,
      credential_config: {
        chain_id: context.chainId,
        wallet_address: context.userAddress,
      },
    }

    flowState.value = KeyringFlowState.Progress
    clearCredentialData()
    error.value = undefined
    statusMessage.value = undefined

    try {
      await KeyringConnect.launchExtension(config)
      if (!isAttemptCurrent(context, attempt)) return
      startStatusPolling(context, attempt)
    }
    catch (err) {
      if (!isAttemptCurrent(context, attempt)) return
      logWarn('useKeyring: Failed to launch extension', err)
      flowState.value = KeyringFlowState.Error
      error.value = 'Failed to launch Keyring extension'
    }
  }

  const retryVerification = async () => {
    const context = captureContext()
    if (!context) return

    if (policyId.value === undefined || !keyringContractAddress.value) {
      await checkCredential(() => isContextCurrent(context))
      if (!isContextCurrent(context)) return
      if (flowState.value !== KeyringFlowState.Start && flowState.value !== KeyringFlowState.Install) return
    }

    if (!isContextCurrent(context)) return
    await launchExtension()
  }

  const stopStatusPolling = () => {
    if (unsubscribeExtension) {
      unsubscribeExtension()
      unsubscribeExtension = null
    }
  }

  const handleExtensionState = async (
    state: ExtensionState | null,
    context: KeyringContext,
    attempt: number,
    stateVersion: number,
    manualCheck = false,
  ) => {
    if (!isAttemptCurrent(context, attempt) || stateVersion !== extensionStateVersion) return

    if (!state) {
      clearCredentialData()
      flowState.value = KeyringFlowState.Progress
      statusMessage.value = 'Could not reach the Keyring extension. Retrying…'
      return
    }

    const cred = state.credentialData
    if (cred) {
      if (isCredentialForContext(cred, context.userAddress, policyId.value, context.chainId)) {
        credentialData.value = cred
        scheduleCredentialExpiry(cred, context)
        flowState.value = KeyringFlowState.Ready
        statusMessage.value = undefined
      }
      else {
        clearCredentialData()
        flowState.value = KeyringFlowState.Start
        statusMessage.value = isCredentialIdentityForContext(cred, context.userAddress, policyId.value, context.chainId)
          ? 'Your previous Keyring credential has expired. Restart verification to continue.'
          : 'Restart verification for the connected wallet, policy, and network.'
      }
      stopStatusPolling()
      return
    }

    if (state.status === 'error' || state.status === 'prove_error') {
      clearCredentialData()
      flowState.value = KeyringFlowState.Error
      error.value = state.error || 'Keyring verification failed'
      statusMessage.value = undefined
      stopStatusPolling()
      return
    }

    const extensionUserMatches = state.user?.wallet_address?.toLowerCase() === context.userAddress.toLowerCase()
    if (extensionUserMatches && state.user?.credential_status === 'valid') {
      await checkCredential(() => isAttemptCurrent(context, attempt) && stateVersion === extensionStateVersion)
      if (isAttemptCurrent(context, attempt)
        && stateVersion === extensionStateVersion
        && (flowState.value === KeyringFlowState.Idle || flowState.value === KeyringFlowState.Ready)) {
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
      flowState.value = KeyringFlowState.Progress
      statusMessage.value = 'Verification is not complete yet. Continue in the Keyring extension.'
    }
  }

  const processExtensionState = (
    state: ExtensionState | null,
    context: KeyringContext,
    attempt: number,
    manualCheck = false,
  ) => {
    if (!isAttemptCurrent(context, attempt)) return
    const stateVersion = ++extensionStateVersion
    return handleExtensionState(state, context, attempt, stateVersion, manualCheck)
  }

  const startStatusPolling = (context: KeyringContext, attempt: number) => {
    stopStatusPolling()
    unsubscribeExtension = KeyringConnect.subscribeToExtensionState((state) => {
      void processExtensionState(state, context, attempt)
    })
  }

  const checkStatus = async () => {
    const context = captureContext()
    const attempt = verificationAttempt
    if (!context || !isAttemptCurrent(context, attempt)) return
    const stateVersion = extensionStateVersion

    isCheckingStatus.value = true
    try {
      const state = await KeyringConnect.getExtensionState()
      if (!isAttemptCurrent(context, attempt) || stateVersion !== extensionStateVersion) return
      await processExtensionState(state, context, attempt, true)
    }
    catch (err) {
      if (!isAttemptCurrent(context, attempt) || stateVersion !== extensionStateVersion) return
      logWarn('useKeyring: Failed to check extension status', err)
      flowState.value = KeyringFlowState.Error
      error.value = 'Failed to check Keyring extension status'
      statusMessage.value = undefined
    }
    finally {
      if (isAttemptCurrent(context, attempt)) {
        isCheckingStatus.value = false
      }
    }
  }

  const cancelVerification = () => {
    verificationAttempt += 1
    stopStatusPolling()
    isCheckingStatus.value = false
    flowState.value = KeyringFlowState.Start
    clearCredentialData()
    error.value = undefined
    statusMessage.value = undefined
  }

  // Re-check extension state when user returns to the tab (e.g. after installing the extension)
  const onVisibilityChange = () => {
    if (document.visibilityState === 'visible' && flowState.value === KeyringFlowState.Install) {
      const context = captureContext()
      if (context) void initExtensionState(context)
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
    [addressRef, userAddress, hookTarget, chainId, rpcUrl],
    () => {
      contextVersion += 1
      credentialCheckVersion += 1
      verificationAttempt += 1
      stopStatusPolling()
      extensionStateVersion += 1
      clearCredentialExpiryTimer()
      isLoading.value = false
      isCheckingStatus.value = false
      credentialData.value = null
      hasValidCredential.value = false
      policyId.value = undefined
      keyringContractAddress.value = undefined
      expiration.value = undefined
      error.value = undefined
      statusMessage.value = undefined
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
    disposed = true
    if (typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', onVisibilityChange)
    }
    stopStatusPolling()
    clearCredentialExpiryTimer()
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
    rpcUrl,
    launchExtension,
    retryVerification,
    checkStatus,
    cancelVerification,
  }
}
