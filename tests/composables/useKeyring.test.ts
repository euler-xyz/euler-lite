import { effectScope, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Address } from 'viem'
import type { CredentialData, ExtensionState } from '@keyringnetwork/keyring-connect-sdk'

const USER = '0x1111111111111111111111111111111111111111' as Address
const OTHER_USER = '0x2222222222222222222222222222222222222222' as Address
const VAULT = '0x3333333333333333333333333333333333333333' as Address
const HOOK_TARGET = '0x4444444444444444444444444444444444444444' as Address
const KEYRING = '0x5555555555555555555555555555555555555555' as Address

const userAddress = ref<Address | undefined>(USER)
const chainId = ref(1)
const readContract = vi.fn()
const getCode = vi.fn()
const logWarn = vi.fn()
const isInstalled = vi.fn()
const getExtensionState = vi.fn()
const launchExtension = vi.fn()
const subscribeToExtensionState = vi.fn()
const vaultAvailable = ref(true)

vi.mock('vue', async importOriginal => ({
  ...await importOriginal<typeof import('vue')>(),
  onUnmounted: vi.fn(),
}))

vi.mock('@wagmi/vue', () => ({
  useChainId: () => chainId,
}))

vi.mock('@keyringnetwork/keyring-connect-sdk', () => ({
  KeyringConnect: {
    isKeyringConnectInstalled: isInstalled,
    getExtensionState,
    launchExtension,
    subscribeToExtensionState,
  },
}))

vi.mock('~/utils/eulerLabelsUtils', () => ({
  isVaultKeyring: (address: string) => address.toLowerCase() === VAULT.toLowerCase(),
}))

vi.mock('~/utils/public-client', () => ({
  getPublicClient: () => ({ readContract, getCode }),
}))

vi.mock('~/utils/vault-hooks', () => ({
  getVaultHookTarget: () => HOOK_TARGET,
}))

vi.mock('~/utils/errorHandling', () => ({
  logWarn,
}))

const credential = (overrides: Partial<CredentialData> = {}): CredentialData => ({
  trader: USER,
  policyId: 7,
  chainId: 1,
  validUntil: 2_000_000_000,
  cost: 1,
  key: '0x01',
  signature: '0x02',
  backdoor: '0x03',
  ...overrides,
})

const extensionState = (overrides: Partial<ExtensionState> = {}): ExtensionState => ({
  status: 'mounted',
  manifest: {},
  ...overrides,
})

const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const installContractReads = (hasCredential = false) => {
  readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
    if (functionName === 'policyId') return 7
    if (functionName === 'keyring') return KEYRING
    if (functionName === 'checkKeyringCredentialOrWildCard') return hasCredential
    if (functionName === 'entityExp') return 0n
    throw new Error(`Unexpected contract read: ${functionName}`)
  })
}

describe('useKeyring', () => {
  let scope = effectScope()

  beforeEach(() => {
    scope.stop()
    scope = effectScope()
    userAddress.value = USER
    chainId.value = 1
    readContract.mockReset()
    getCode.mockReset()
    getCode.mockResolvedValue('0x1234')
    isInstalled.mockReset()
    getExtensionState.mockReset()
    launchExtension.mockReset()
    subscribeToExtensionState.mockReset()
    subscribeToExtensionState.mockReturnValue(vi.fn())
    vaultAvailable.value = true
    vi.stubGlobal('useWagmi', () => ({ address: userAddress }))
    vi.stubGlobal('useVaultRegistry', () => ({
      getVault: () => vaultAvailable.value ? { address: VAULT } : undefined,
    }))
    vi.stubGlobal('useRpcClient', () => ({ rpcUrl: ref('/api/internal/rpc/1') }))
    vi.stubGlobal('document', {
      visibilityState: 'visible',
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })
    vi.stubGlobal('window', {
      location: {
        origin: 'https://app.euler.finance',
      },
    })
  })

  afterEach(() => {
    scope.stop()
    vi.unstubAllGlobals()
  })

  it('blocks the operation while the initial on-chain check is pending', async () => {
    let resolveCredentialCheck: ((value: boolean) => void) | undefined
    const pendingCredentialCheck = new Promise<boolean>((resolve) => {
      resolveCredentialCheck = resolve
    })
    installContractReads()
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'policyId') return 7
      if (functionName === 'keyring') return KEYRING
      if (functionName === 'checkKeyringCredentialOrWildCard') return pendingCredentialCheck
      if (functionName === 'entityExp') return 0n
      throw new Error(`Unexpected contract read: ${functionName}`)
    })
    isInstalled.mockResolvedValue(false)

    const { KeyringFlowState, useKeyring } = await import('~/composables/useKeyring')
    const state = scope.run(() => useKeyring(VAULT))!

    expect(state.flowState.value).toBe(KeyringFlowState.Loading)
    expect(state.isVerificationRequired.value).toBe(true)

    resolveCredentialCheck?.(false)
    await vi.waitFor(() => expect(state.flowState.value).toBe(KeyringFlowState.Install))
  })

  it('keeps the Keyring gate loading until hook metadata is available', async () => {
    vaultAvailable.value = false
    installContractReads()
    isInstalled.mockResolvedValue(false)

    const { KeyringFlowState, useKeyring } = await import('~/composables/useKeyring')
    const state = scope.run(() => useKeyring(VAULT))!

    expect(state.flowState.value).toBe(KeyringFlowState.Loading)
    expect(state.isVerificationRequired.value).toBe(true)
    expect(readContract).not.toHaveBeenCalled()

    vaultAvailable.value = true
    await vi.waitFor(() => expect(state.flowState.value).toBe(KeyringFlowState.Install))
  })

  it('launches the SDK flow from the install state', async () => {
    installContractReads()
    isInstalled.mockResolvedValue(false)
    launchExtension.mockResolvedValue(undefined)

    const { KeyringFlowState, useKeyring } = await import('~/composables/useKeyring')
    const state = scope.run(() => useKeyring(VAULT))!
    await vi.waitFor(() => expect(state.flowState.value).toBe(KeyringFlowState.Install))

    await state.launchExtension()

    expect(launchExtension).toHaveBeenCalledWith(expect.objectContaining({
      app_url: 'https://app.euler.finance',
      policy_id: 7,
      credential_config: {
        chain_id: 1,
        wallet_address: USER,
      },
    }))
    expect(subscribeToExtensionState).toHaveBeenCalledOnce()
  })

  it.each([
    ['wallet', { trader: OTHER_USER }],
    ['policy', { policyId: 8 }],
    ['network', { chainId: 8453 }],
  ] as const)('does not accept credential data for another %s', async (_context, credentialOverrides) => {
    installContractReads()
    isInstalled.mockResolvedValue(true)
    getExtensionState
      .mockResolvedValueOnce(extensionState())
      .mockResolvedValueOnce(extensionState({ credentialData: credential(credentialOverrides) }))

    const { KeyringFlowState, useKeyring } = await import('~/composables/useKeyring')
    const state = scope.run(() => useKeyring(VAULT))!
    await vi.waitFor(() => expect(state.flowState.value).toBe(KeyringFlowState.Start))

    state.flowState.value = KeyringFlowState.Progress
    await state.checkStatus()

    expect(state.credentialData.value).toBeNull()
    expect(state.flowState.value).toBe(KeyringFlowState.Start)
    expect(state.statusMessage.value).toContain('connected wallet, policy, and network')
  })

  it('accepts credential data only for the active wallet, policy, and chain', async () => {
    installContractReads()
    isInstalled.mockResolvedValue(true)
    getExtensionState
      .mockResolvedValueOnce(extensionState())
      .mockResolvedValueOnce(extensionState({ credentialData: credential() }))

    const { KeyringFlowState, useKeyring } = await import('~/composables/useKeyring')
    const state = scope.run(() => useKeyring(VAULT))!
    await vi.waitFor(() => expect(state.flowState.value).toBe(KeyringFlowState.Start))

    state.flowState.value = KeyringFlowState.Progress
    await state.checkStatus()

    expect(state.credentialData.value).toEqual(credential())
    expect(state.flowState.value).toBe(KeyringFlowState.Ready)
  })

  it('keeps transient extension timeouts retryable and recovers on the next state', async () => {
    installContractReads()
    isInstalled.mockResolvedValue(true)
    getExtensionState
      .mockResolvedValueOnce(extensionState())
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(extensionState({ status: 'proving' }))

    const { KeyringFlowState, useKeyring } = await import('~/composables/useKeyring')
    const state = scope.run(() => useKeyring(VAULT))!
    await vi.waitFor(() => expect(state.flowState.value).toBe(KeyringFlowState.Start))

    state.flowState.value = KeyringFlowState.Progress
    await state.checkStatus()

    expect(state.flowState.value).toBe(KeyringFlowState.Progress)
    expect(state.statusMessage.value).toContain('Retrying')

    await state.checkStatus()
    expect(state.flowState.value).toBe(KeyringFlowState.Progress)
    expect(state.statusMessage.value).toContain('still in progress')
  })

  it('does not let a delayed timeout probe overwrite a newer credential state', async () => {
    installContractReads()
    isInstalled.mockResolvedValue(true)
    getExtensionState.mockResolvedValueOnce(extensionState())
    launchExtension.mockResolvedValue(undefined)

    const { KeyringFlowState, useKeyring } = await import('~/composables/useKeyring')
    const state = scope.run(() => useKeyring(VAULT))!
    await vi.waitFor(() => expect(state.flowState.value).toBe(KeyringFlowState.Start))

    const installedCheck = deferred<boolean>()
    isInstalled.mockReturnValueOnce(installedCheck.promise)
    await state.launchExtension()
    const onExtensionState = subscribeToExtensionState.mock.calls[0][0] as (state: ExtensionState | null) => void

    onExtensionState(null)
    onExtensionState(extensionState({ credentialData: credential() }))
    await vi.waitFor(() => expect(state.flowState.value).toBe(KeyringFlowState.Ready))

    installedCheck.resolve(true)
    await nextTick()

    expect(state.flowState.value).toBe(KeyringFlowState.Ready)
    expect(state.credentialData.value).toEqual(credential())
  })

  it('returns to install only after confirming the extension is absent', async () => {
    installContractReads()
    isInstalled
      .mockResolvedValueOnce(true)
      .mockResolvedValueOnce(false)
    getExtensionState
      .mockResolvedValueOnce(extensionState())
      .mockResolvedValueOnce(null)

    const { KeyringFlowState, useKeyring } = await import('~/composables/useKeyring')
    const state = scope.run(() => useKeyring(VAULT))!
    await vi.waitFor(() => expect(state.flowState.value).toBe(KeyringFlowState.Start))

    state.flowState.value = KeyringFlowState.Progress
    await state.checkStatus()

    expect(state.flowState.value).toBe(KeyringFlowState.Install)
  })

  it('reports an incomplete manual status check instead of silently staying in progress', async () => {
    installContractReads()
    isInstalled.mockResolvedValue(true)
    getExtensionState
      .mockResolvedValueOnce(extensionState())
      .mockResolvedValueOnce(extensionState({ status: 'mounted' }))

    const { KeyringFlowState, useKeyring } = await import('~/composables/useKeyring')
    const state = scope.run(() => useKeyring(VAULT))!
    await vi.waitFor(() => expect(state.flowState.value).toBe(KeyringFlowState.Start))

    state.flowState.value = KeyringFlowState.Progress
    await state.checkStatus()
    await nextTick()

    expect(state.flowState.value).toBe(KeyringFlowState.Start)
    expect(state.statusMessage.value).toContain('not complete yet')
    expect(state.isCheckingStatus.value).toBe(false)
  })

  it('rejects a cached extension credential after it expires', async () => {
    installContractReads()
    isInstalled.mockResolvedValue(true)
    getExtensionState.mockResolvedValueOnce(extensionState({
      credentialData: credential({ validUntil: 1 }),
    }))

    const { KeyringFlowState, useKeyring } = await import('~/composables/useKeyring')
    const state = scope.run(() => useKeyring(VAULT))!

    await vi.waitFor(() => expect(state.flowState.value).toBe(KeyringFlowState.Start))
    expect(state.credentialData.value).toBeNull()
    expect(state.statusMessage.value).toContain('expired')
  })

  it('re-reads hook metadata before retrying a metadata failure', async () => {
    readContract.mockRejectedValue(new Error('temporary RPC failure'))
    isInstalled.mockResolvedValue(false)
    launchExtension.mockResolvedValue(undefined)

    const { KeyringFlowState, useKeyring } = await import('~/composables/useKeyring')
    const state = scope.run(() => useKeyring(VAULT))!
    await vi.waitFor(() => expect(state.flowState.value).toBe(KeyringFlowState.Error))

    installContractReads()
    await state.retryVerification()

    expect(state.policyId.value).toBe(7)
    expect(launchExtension).toHaveBeenCalledOnce()
    expect(state.flowState.value).toBe(KeyringFlowState.Progress)
  })

  it('does not restart polling after verification is canceled during launch', async () => {
    installContractReads()
    isInstalled.mockResolvedValue(false)
    const launch = deferred<undefined>()
    launchExtension.mockReturnValue(launch.promise)

    const { KeyringFlowState, useKeyring } = await import('~/composables/useKeyring')
    const state = scope.run(() => useKeyring(VAULT))!
    await vi.waitFor(() => expect(state.flowState.value).toBe(KeyringFlowState.Install))

    const launching = state.launchExtension()
    expect(state.flowState.value).toBe(KeyringFlowState.Progress)
    state.cancelVerification()
    launch.resolve(undefined)
    await launching

    expect(state.flowState.value).toBe(KeyringFlowState.Start)
    expect(subscribeToExtensionState).not.toHaveBeenCalled()
  })

  it('discards an older credential check after the active chain changes', async () => {
    const oldPolicy = deferred<number>()
    const oldKeyring = deferred<Address>()
    const oldCredentialCheck = deferred<boolean>()
    let callIndex = 0
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      callIndex += 1
      if (callIndex === 1) return oldPolicy.promise
      if (callIndex === 2) return oldKeyring.promise
      if (callIndex === 3) return oldCredentialCheck.promise
      if (functionName === 'policyId') return 8
      if (functionName === 'keyring') return KEYRING
      if (functionName === 'checkKeyringCredentialOrWildCard') return false
      if (functionName === 'entityExp') return 0n
      throw new Error(`Unexpected contract read: ${functionName}`)
    })
    isInstalled.mockResolvedValue(false)

    const { KeyringFlowState, useKeyring } = await import('~/composables/useKeyring')
    const state = scope.run(() => useKeyring(VAULT))!
    expect(state.flowState.value).toBe(KeyringFlowState.Loading)

    chainId.value = 8453
    await vi.waitFor(() => expect(state.flowState.value).toBe(KeyringFlowState.Install))
    expect(state.policyId.value).toBe(8)

    oldPolicy.resolve(7)
    oldKeyring.resolve(KEYRING)
    oldCredentialCheck.resolve(true)
    await nextTick()

    expect(state.policyId.value).toBe(8)
    expect(state.hasValidCredential.value).toBe(false)
    expect(state.flowState.value).toBe(KeyringFlowState.Install)
  })

  it('rejects a Keyring destination with no deployed code', async () => {
    installContractReads()
    getCode.mockResolvedValue('0x')

    const { KeyringFlowState, useKeyring } = await import('~/composables/useKeyring')
    const state = scope.run(() => useKeyring(VAULT))!

    await vi.waitFor(() => expect(state.flowState.value).toBe(KeyringFlowState.Error))
    expect(state.keyringContractAddress.value).toBeUndefined()
  })

  it('rejects the zero address as a Keyring destination', async () => {
    installContractReads()
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'policyId') return 7
      if (functionName === 'keyring') return '0x0000000000000000000000000000000000000000'
      if (functionName === 'checkKeyringCredentialOrWildCard') return false
      throw new Error(`Unexpected contract read: ${functionName}`)
    })

    const { KeyringFlowState, useKeyring } = await import('~/composables/useKeyring')
    const state = scope.run(() => useKeyring(VAULT))!

    await vi.waitFor(() => expect(state.flowState.value).toBe(KeyringFlowState.Error))
    expect(state.keyringContractAddress.value).toBeUndefined()
    expect(getCode).not.toHaveBeenCalled()
  })
})

describe('readHookTargetValue — native/integrator getter fallback', () => {
  const RPC = '/api/internal/rpc/1'

  beforeEach(() => {
    readContract.mockReset()
    logWarn.mockReset()
  })

  it('uses the native getter and makes no fallback call when policyId() resolves', async () => {
    const { readHookTargetValue } = await import('~/composables/useKeyring')
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'policyId') return 7
      throw new Error(`unexpected getter: ${functionName}`)
    })

    const value = await readHookTargetValue<number>(RPC, HOOK_TARGET, ['policyId', 'getPolicyId'])

    expect(value).toBe(7)
    expect(readContract).toHaveBeenCalledTimes(1)
    expect(readContract.mock.calls[0][0]).toMatchObject({ functionName: 'policyId' })
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('falls back to getPolicyId() when policyId() reverts', async () => {
    const { readHookTargetValue } = await import('~/composables/useKeyring')
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'policyId') throw new Error('execution reverted')
      if (functionName === 'getPolicyId') return 14623209
      throw new Error(`unexpected getter: ${functionName}`)
    })

    const value = await readHookTargetValue<number>(RPC, HOOK_TARGET, ['policyId', 'getPolicyId'])

    expect(value).toBe(14623209)
    expect(readContract).toHaveBeenCalledTimes(2)
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('falls back to getKeyring() when keyring() reverts', async () => {
    const { readHookTargetValue } = await import('~/composables/useKeyring')
    readContract.mockImplementation(async ({ functionName }: { functionName: string }) => {
      if (functionName === 'keyring') throw new Error('execution reverted')
      if (functionName === 'getKeyring') return KEYRING
      throw new Error(`unexpected getter: ${functionName}`)
    })

    const value = await readHookTargetValue<string>(RPC, HOOK_TARGET, ['keyring', 'getKeyring'])

    expect(value).toBe(KEYRING)
    expect(logWarn).not.toHaveBeenCalled()
  })

  it('returns undefined and logs once at error severity when every candidate reverts', async () => {
    const { readHookTargetValue } = await import('~/composables/useKeyring')
    readContract.mockRejectedValue(new Error('execution reverted'))

    const value = await readHookTargetValue<number>(RPC, HOOK_TARGET, ['policyId', 'getPolicyId'])

    expect(value).toBeUndefined()
    expect(logWarn).toHaveBeenCalledTimes(1)
    // logWarn(context, lastError, { severity })
    expect(logWarn.mock.calls[0][2]).toMatchObject({ severity: 'error' })
  })
})
