import { computed, createRenderer, h, inject, nextTick, ref, type Ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { operationBlockerEntries, unregisterOperationBlocker } from '~/utils/operationGuardRegistry'
import { useUnverifiedVaultGuard, type UnverifiedVaultGuardState } from '~/composables/guards/useUnverifiedVaultGuard'

const VAULT = '0x00000000000000000000000000000000000000a1'
const ACCOUNT = '0x00000000000000000000000000000000000000b1'

const registryVersion = ref(0)
const entries = new Map<string, { type: 'evk', vault: { chainId: number, address: string } }>()
const verifyEVault = vi.fn()
const labelsReady = ref(true)
const labelsError = ref<string | undefined>()
const retryLabels = vi.fn()

vi.mock('~/composables/useEulerLabels', () => ({
  getEulerLabelsVersion: () => 1,
}))

const mountGuard = (options?: { chainId?: Ref<number | undefined>, account?: Ref<string | undefined>, operation?: Ref<string> }) => {
  let state: UnverifiedVaultGuardState | undefined
  const chainId = options?.chainId ?? ref<number | undefined>(1)
  const account = options?.account ?? ref<string | undefined>(ACCOUNT)
  const operation = options?.operation ?? ref('lend-vault')
  const renderer = createRenderer({
    patchProp: () => undefined,
    insert: () => undefined,
    remove: () => undefined,
    createElement: (type: string) => ({ type }),
    createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }),
    setText: () => undefined,
    setElementText: () => undefined,
    parentNode: () => null,
    nextSibling: () => null,
    insertStaticContent: () => undefined as never,
  })
  const app = renderer.createApp({
    setup() {
      useUnverifiedVaultGuard(computed(() => [VAULT]), {
        chainId,
        account,
        operation: computed(() => operation.value),
      })
      return () => h({
        setup() {
          state = inject<UnverifiedVaultGuardState>('unverified-vault-guard')
          return () => h('span')
        },
      })
    },
  })
  app.mount({ type: 'root' })
  if (!state) throw new Error('Unverified vault guard was not provided')
  return { app, state, chainId, account, operation }
}

describe('useUnverifiedVaultGuard canonical context', () => {
  beforeEach(() => {
    entries.clear()
    labelsReady.value = true
    labelsError.value = undefined
    retryLabels.mockReset()
    vi.stubGlobal('useEulerLabels', () => ({ isReady: labelsReady, loadError: labelsError, retryLabels }))
    registryVersion.value = 0
    verifyEVault.mockReset()
    vi.stubGlobal('useVaultRegistry', () => ({
      get: (address: string) => entries.get(address.toLowerCase()),
      getOrFetch: vi.fn(async () => undefined),
      registryVersion,
    }))
    vi.stubGlobal('useVaults', () => ({
      isVaultGovernorVerified: verifyEVault,
      isEarnVaultOwnerVerified: vi.fn(),
      isSecuritizeGovernorVerified: vi.fn(),
    }))
  })

  afterEach(() => {
    for (const [key] of operationBlockerEntries.value) {
      if (key.startsWith('unverified-vault:')) unregisterOperationBlocker(key)
    }
    vi.unstubAllGlobals()
  })

  it('uses the canonical governor rule and invalidates consent when the operation changes', async () => {
    entries.set(VAULT.toLowerCase(), { type: 'evk', vault: { chainId: 1, address: VAULT } })
    verifyEVault.mockReturnValue(false)
    const mounted = mountGuard()
    await nextTick()

    expect(verifyEVault).toHaveBeenCalled()
    expect(mounted.state.isAcknowledgmentRequired).toBe(true)
    mounted.state.acknowledgeRisk()
    expect(mounted.state.isAcknowledgmentRequired).toBe(false)

    mounted.operation.value = 'position-number-supply'
    await nextTick()
    expect(mounted.state.isAcknowledgmentRequired).toBe(true)
    mounted.app.unmount()
  })

  it('fails closed for unresolved or wrong-chain vault metadata', async () => {
    entries.set(VAULT.toLowerCase(), { type: 'evk', vault: { chainId: 8453, address: VAULT } })
    verifyEVault.mockReturnValue(true)
    const mounted = mountGuard()
    await nextTick()

    expect(verifyEVault).not.toHaveBeenCalled()
    expect(mounted.state.isAcknowledgmentRequired).toBe(false)
    expect(operationBlockerEntries.value.length).toBeGreaterThan(0)
    mounted.app.unmount()
  })
  it('blocks unresolved labels without asking the user to acknowledge missing data', async () => {
    entries.set(VAULT.toLowerCase(), { type: 'evk', vault: { chainId: 1, address: VAULT } })
    labelsReady.value = false
    const mounted = mountGuard()
    await nextTick()
    expect(mounted.state.isVerificationLoading).toBe(true)
    expect(mounted.state.isAcknowledgmentRequired).toBe(false)
    mounted.state.acknowledgeRisk()
    labelsError.value = 'Temporary verification failure'
    await nextTick()
    expect(mounted.state.verificationError).toBe('Temporary verification failure')
    expect(mounted.state.isAcknowledgmentRequired).toBe(false)
    retryLabels.mockImplementation(async () => {
      labelsReady.value = true
      labelsError.value = undefined
    })
    verifyEVault.mockReturnValue(false)
    await mounted.state.retryVerification()
    expect(mounted.state.isAcknowledgmentRequired).toBe(true)
    mounted.app.unmount()
  })

  it('removes the acknowledgement requirement when canonical verification recovers', async () => {
    entries.set(VAULT.toLowerCase(), { type: 'evk', vault: { chainId: 1, address: VAULT } })
    verifyEVault.mockReturnValue(false)
    const mounted = mountGuard()
    expect(mounted.state.isAcknowledgmentRequired).toBe(true)
    verifyEVault.mockReturnValue(true)
    registryVersion.value++
    await nextTick()
    expect(mounted.state.isAcknowledgmentRequired).toBe(false)
    expect(operationBlockerEntries.value).toEqual([])
    mounted.app.unmount()
  })

  it('invalidates acknowledgement after an account change', async () => {
    entries.set(VAULT.toLowerCase(), { type: 'evk', vault: { chainId: 1, address: VAULT } })
    verifyEVault.mockReturnValue(false)
    const mounted = mountGuard()
    mounted.state.acknowledgeRisk()
    expect(mounted.state.isAcknowledgmentRequired).toBe(false)
    mounted.account.value = '0x00000000000000000000000000000000000000c1'
    await nextTick()
    expect(mounted.state.isAcknowledgmentRequired).toBe(true)
    mounted.app.unmount()
  })
})
