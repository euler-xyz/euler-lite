import { computed, createRenderer, h, inject, nextTick, ref, type Ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { isOperationBlocked, operationBlockerEntries, unregisterOperationBlocker } from '~/utils/operationGuardRegistry'
import { useUnverifiedVaultGuard, type UnverifiedVaultGuardState } from '~/composables/guards/useUnverifiedVaultGuard'

const VAULT = '0x00000000000000000000000000000000000000a1'

const registryVersion = ref(0)
const chainId = ref(1)
const entries = new Map<string, {
  type: 'evk' | 'earn' | 'securitize'
  vault: { chainId: number, address: string }
}>()
const verifyEVault = vi.fn()
const verifyEarn = vi.fn()
const verifySecuritize = vi.fn()

const mountGuard = (vaultAddresses: Ref<string[]>) => {
  let state: UnverifiedVaultGuardState | undefined
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
      useUnverifiedVaultGuard(computed(() => vaultAddresses.value))
      return () => h({
        setup() {
          state = inject<UnverifiedVaultGuardState>('unverified-vault-guard')
          return () => h('span')
        },
      })
    },
  })
  app.mount({ type: 'root' })
  if (!state) throw new Error('Unverified-vault guard was not provided')
  return { app, state }
}

describe('useUnverifiedVaultGuard canonical verification', () => {
  beforeEach(() => {
    entries.clear()
    registryVersion.value = 0
    chainId.value = 1
    verifyEVault.mockReset()
    verifyEarn.mockReset()
    verifySecuritize.mockReset()

    vi.stubGlobal('useEulerAddresses', () => ({ chainId }))
    vi.stubGlobal('useVaultRegistry', () => ({
      get: (address: string) => entries.get(address.toLowerCase()),
      getOrFetch: vi.fn(async () => undefined),
      registryVersion,
    }))
    vi.stubGlobal('useVaults', () => ({
      isVaultGovernorVerified: verifyEVault,
      isEarnVaultOwnerVerified: verifyEarn,
      isSecuritizeGovernorVerified: verifySecuritize,
    }))
  })

  afterEach(() => {
    for (const [key] of operationBlockerEntries.value) {
      if (key.startsWith('unverified-vault:')) unregisterOperationBlocker(key)
    }
    vi.unstubAllGlobals()
  })

  it('requires acknowledgement when a listed EVault fails the live governor rule', async () => {
    entries.set(VAULT.toLowerCase(), { type: 'evk', vault: { chainId: 1, address: VAULT } })
    verifyEVault.mockReturnValue(false)

    const { app, state } = mountGuard(ref([VAULT]))
    await nextTick()

    expect(verifyEVault).toHaveBeenCalledTimes(1)
    expect(state.isAcknowledgmentRequired).toBe(true)
    expect(isOperationBlocked.value).toBe(true)
    app.unmount()
  })

  it('clears the guard only after the canonical verifier accepts the resolved type', async () => {
    entries.set(VAULT.toLowerCase(), { type: 'earn', vault: { chainId: 1, address: VAULT } })
    verifyEarn.mockReturnValue(true)

    const { app, state } = mountGuard(ref([VAULT]))
    await nextTick()

    expect(verifyEarn).toHaveBeenCalledTimes(1)
    expect(state.isAcknowledgmentRequired).toBe(false)
    expect(isOperationBlocked.value).toBe(false)
    app.unmount()
  })

  it('fails closed for a registry entry from another chain', async () => {
    entries.set(VAULT.toLowerCase(), { type: 'evk', vault: { chainId: 8453, address: VAULT } })
    verifyEVault.mockReturnValue(true)

    const { app, state } = mountGuard(ref([VAULT]))
    await nextTick()

    expect(verifyEVault).not.toHaveBeenCalled()
    expect(state.isAcknowledgmentRequired).toBe(true)
    app.unmount()
  })
})
