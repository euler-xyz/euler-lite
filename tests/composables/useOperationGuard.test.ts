import { createRenderer, h, nextTick, ref } from 'vue'
import { createConfig, http } from '@wagmi/core'
import { WagmiPlugin } from '@wagmi/vue'
import { mainnet, monad } from 'viem/chains'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOperationGuard } from '~/composables/useOperationGuard'

vi.mock('~/composables/useEulerLabels', () => ({ getEulerLabelsVersion: () => 1 }))
vi.mock('~/composables/guards/useTosGuard', () => ({ useTosGuard: () => ({}) }))
vi.mock('~/utils/eulerLabelsUtils', () => ({ isVaultKeyring: () => false }))
vi.mock('~/composables/useKeyring', () => ({
  useKeyring: () => ({
    isVerificationRequired: ref(false),
    credentialData: ref(null),
    hookTarget: ref(null),
    policyId: ref(undefined),
    keyringContractAddress: ref(undefined),
    rpcUrl: ref(undefined),
  }),
}))

describe('operation verification chain', () => {
  afterEach(() => vi.unstubAllGlobals())

  it('verifies a Monad Earn vault while disconnected Wagmi still defaults to Ethereum', async () => {
    const vault = { address: '0x00000000000000000000000000000000000000a1', chainId: 143 }
    const verifyOwner = vi.fn(() => true)
    vi.stubGlobal('useWagmi', () => ({ address: ref(undefined) }))
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(143) }))
    vi.stubGlobal('useRoute', () => ({ name: 'earn-vault' }))
    vi.stubGlobal('useEulerLabels', () => ({
      isReady: ref(true), loadError: ref(undefined), retryLabels: vi.fn(),
    }))
    vi.stubGlobal('useVaultRegistry', () => ({
      get: () => ({ type: 'earn', vault }),
      getOrFetch: async () => vault,
      registryVersion: ref(1),
    }))
    vi.stubGlobal('useVaults', () => ({ isEarnVaultOwnerVerified: verifyOwner }))
    const config = createConfig({
      chains: [mainnet, monad],
      transports: { 1: http(), 143: http() },
      storage: null,
    })
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
    let state: ReturnType<typeof useOperationGuard> | undefined
    const app = renderer.createApp({
      setup() {
        state = useOperationGuard([vault.address])
        return () => h('span')
      },
    })
    app.use(WagmiPlugin, { config, reconnectOnMount: false })
    app.mount({ type: 'root' })
    try {
      await nextTick()
      expect(config.state.chainId).toBe(1)
      expect(verifyOwner).toHaveBeenCalledWith(vault)
      expect(state?.unverifiedVaultGuard.isAcknowledgmentRequired).toBe(false)
      expect(state?.unverifiedVaultGuard.verificationError).toBeUndefined()
      config.setState(previous => ({ ...previous, chainId: 143 }))
      await nextTick()
      expect(state?.unverifiedVaultGuard.isAcknowledgmentRequired).toBe(false)
    }
    finally {
      app.unmount()
    }
  })
})
