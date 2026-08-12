import { createRenderer, h, nextTick, ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { operationBlockerEntries, unregisterOperationBlocker } from '~/utils/operationGuardRegistry'
import { useOperationGuard } from '~/composables/useOperationGuard'

const labelsVersion = ref(0)
const registryVersion = ref(0)
let geoBlocked = false

vi.mock('@wagmi/vue', () => ({
  useChainId: () => ref(1),
}))
vi.mock('~/composables/useEulerLabels', () => ({
  getEulerLabelsVersion: () => labelsVersion.value,
}))
vi.mock('~/composables/useGeoBlock', () => ({
  getVaultOperationGeoBlockReason: () => geoBlocked ? 'This operation is not available in your region' : undefined,
}))
vi.mock('~/composables/guards/useTosGuard', () => ({ useTosGuard: vi.fn() }))
vi.mock('~/composables/guards/useUnverifiedVaultGuard', () => ({ useUnverifiedVaultGuard: vi.fn() }))
vi.mock('~/utils/eulerLabelsUtils', () => ({ isVaultKeyring: () => false }))
vi.mock('~/composables/useKeyring', () => ({
  useKeyring: () => ({
    isVerificationRequired: ref(false),
    isExpired: ref(false),
    flowState: ref('idle'),
    credentialData: ref(undefined),
    isCheckingStatus: ref(false),
    statusMessage: ref(''),
    error: ref(''),
    hookTarget: ref(undefined),
    policyId: ref(undefined),
    keyringContractAddress: ref(undefined),
    rpcUrl: ref(undefined),
    launchExtension: vi.fn(),
    retryVerification: vi.fn(),
    checkStatus: vi.fn(),
    cancelVerification: vi.fn(),
  }),
}))

const mountGuard = () => {
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
      useOperationGuard(['0x00000000000000000000000000000000000000a1'])
      return () => h('span')
    },
  })
  app.mount({ type: 'root' })
  return app
}

describe('useOperationGuard geo reactivity', () => {
  beforeEach(() => {
    labelsVersion.value = 0
    registryVersion.value = 0
    geoBlocked = false
    vi.stubGlobal('useWagmi', () => ({ address: ref(undefined) }))
    vi.stubGlobal('useVaultRegistry', () => ({ registryVersion }))
  })

  afterEach(() => {
    unregisterOperationBlocker('geo')
    unregisterOperationBlocker('keyring')
    vi.unstubAllGlobals()
  })

  it('re-evaluates cached geo policy after labels or vault metadata refreshes', async () => {
    const app = mountGuard()
    expect(operationBlockerEntries.value).not.toContainEqual(['geo', expect.any(String)])

    geoBlocked = true
    labelsVersion.value++
    await nextTick()
    expect(operationBlockerEntries.value).toContainEqual(['geo', 'This operation is not available in your region'])

    geoBlocked = false
    registryVersion.value++
    await nextTick()
    expect(operationBlockerEntries.value).not.toContainEqual(['geo', expect.any(String)])
    app.unmount()
  })
})
