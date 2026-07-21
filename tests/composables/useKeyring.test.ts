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
  getPublicClient: () => ({ readContract }),
}))

vi.mock('~/utils/vault-hooks', () => ({
  getVaultHookTarget: () => HOOK_TARGET,
}))

vi.mock('~/utils/errorHandling', () => ({
  logWarn: vi.fn(),
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

  it('returns to install when the extension disappears during verification', async () => {
    installContractReads()
    isInstalled.mockResolvedValue(true)
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
})
