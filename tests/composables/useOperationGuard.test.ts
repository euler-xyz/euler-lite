import { createRenderer, h, nextTick, ref } from 'vue'
import { createConfig, http } from '@wagmi/core'
import { WagmiPlugin } from '@wagmi/vue'
import { mainnet, monad } from 'viem/chains'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useOperationGuard } from '~/composables/useOperationGuard'

import type { HostedGeoContext } from '~/utils/geo-policies'
import { operationBlockerEntries } from '~/utils/operationGuardRegistry'

const hostedGeo = ref<HostedGeoContext | undefined>()

vi.mock('~/composables/useEulerLabels', () => ({ getEulerLabelsVersion: () => 1, getEulerGeoContext: () => hostedGeo.value }))
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

  it.each([true, false])('guards missing geo only for acquisition=%s while using the app verification chain', async (acquiresExposure) => {
    hostedGeo.value = { chainId: 143, policies: undefined, productByVault: {} }
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
        state = useOperationGuard([vault.address], { acquiresExposure })
        return () => h('span')
      },
    })
    app.use(WagmiPlugin, { config, reconnectOnMount: false })
    app.mount({ type: 'root' })
    try {
      await nextTick()
      expect(operationBlockerEntries.value.some(([key]) => key.startsWith('geo-policy:'))).toBe(acquiresExposure)
      hostedGeo.value = { chainId: 143, policies: [], productByVault: {} }
      await nextTick()
      expect(operationBlockerEntries.value.some(([key]) => key.startsWith('geo-policy:'))).toBe(false)
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
      expect(operationBlockerEntries.value.some(([key]) => key.startsWith('geo-policy:'))).toBe(false)
    }
  })
})
