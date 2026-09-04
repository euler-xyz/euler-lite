import { computed, createRenderer, h, inject, nextTick, ref, type Ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { operationBlockerEntries, unregisterOperationBlocker } from '~/utils/operationGuardRegistry'
import { useUnverifiedVaultGuard, type UnverifiedVaultGuardState } from '~/composables/guards/useUnverifiedVaultGuard'

const VAULT = '0x00000000000000000000000000000000000000a1'
const ACCOUNT = '0x00000000000000000000000000000000000000b1'

const registryVersion = ref(0)
const entries = new Map<string, { type: 'evk', vault: { chainId: number, address: string } }>()
const verifyEVault = vi.fn()

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
    expect(mounted.state.isAcknowledgmentRequired).toBe(true)
    mounted.app.unmount()
  })
})
