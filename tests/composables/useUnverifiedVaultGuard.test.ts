import { computed, createRenderer, h, inject, nextTick, ref, type Ref } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isOperationBlocked, unregisterOperationBlocker } from '~/utils/operationGuardRegistry'
import { useUnverifiedVaultGuard, type UnverifiedVaultGuardState } from '~/composables/guards/useUnverifiedVaultGuard'

const verifiedVaultAddresses = ref<string[]>([])
const earnVaults = ref<string[]>([])

vi.stubGlobal('useEulerLabels', () => ({ verifiedVaultAddresses, earnVaults }))
vi.stubGlobal('useVaultRegistry', () => ({ isKnownEscrowAddress: () => false }))

const mountGuard = (
  vaultAddresses: Ref<string[]>,
  account: Ref<string | undefined>,
  chainId: Ref<number | undefined>,
) => {
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
      useUnverifiedVaultGuard(computed(() => vaultAddresses.value), { account, chainId })
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

describe('useUnverifiedVaultGuard', () => {
  afterEach(() => {
    unregisterOperationBlocker('unverified-vault')
  })

  it('requires a new acknowledgement when the guarded vault set changes', async () => {
    const vaultAddresses = ref(['0x00000000000000000000000000000000000000a1'])
    const { app, state } = mountGuard(
      vaultAddresses,
      ref('0x0000000000000000000000000000000000000001'),
      ref(1),
    )

    expect(state.isAcknowledgmentRequired).toBe(true)
    state.acknowledgeRisk()
    await nextTick()
    expect(state.isAcknowledgmentRequired).toBe(false)

    vaultAddresses.value = ['0x00000000000000000000000000000000000000b2']
    await nextTick()

    expect(state.isAcknowledgmentRequired).toBe(true)
    expect(isOperationBlocked.value).toBe(true)
    app.unmount()
  })

  it.each([
    ['account', ref('0x0000000000000000000000000000000000000002'), ref(1)],
    ['chain', ref('0x0000000000000000000000000000000000000001'), ref(2)],
  ])('requires a new acknowledgement when the %s changes', async (_name, nextAccount, nextChainId) => {
    const account = ref<string | undefined>('0x0000000000000000000000000000000000000001')
    const chainId = ref<number | undefined>(1)
    const { app, state } = mountGuard(
      ref(['0x00000000000000000000000000000000000000a1']),
      account,
      chainId,
    )

    state.acknowledgeRisk()
    await nextTick()
    account.value = nextAccount.value
    chainId.value = nextChainId.value
    await nextTick()

    expect(state.isAcknowledgmentRequired).toBe(true)
    expect(isOperationBlocked.value).toBe(true)
    app.unmount()
  })
})
