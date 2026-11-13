import { createRenderer, defineComponent, h, nextTick, ref, ssrContextKey, type App, type Component } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { applyChainReadPolicy, useChainConfig } from '~/composables/useChainConfig'
import { useEulerOracleAdapters } from '~/composables/useEulerOracleAdapters'
import VaultOverviewBlockOracleAdapters from '~/components/entities/vault/overview/VaultOverviewBlockOracleAdapters.vue'
import DiscoveryMarketMatrix from '~/components/entities/vault/discovery/DiscoveryMarketMatrix.vue'
import VaultOverviewBlockVaultChecksCard from '~/components/entities/vault/overview/VaultOverviewBlockVaultChecksCard.vue'
import VaultAssessmentWarning from '~/components/entities/vault/VaultAssessmentWarning.vue'
import { useVaultAssessmentEvidence } from '~/composables/useVaultAssessmentEvidence'

const mocks = vi.hoisted(() => ({ single: vi.fn(), catalogue: vi.fn(), routers: vi.fn() }))
vi.mock('#components', () => ({ OracleAdapterChecksModal: {}, VaultAssessmentChecksModal: {} }))
vi.mock('~/composables/useVaults', () => ({ useVaults: () => ({}) }))
vi.mock('~/composables/useEulerSdk', () => ({ getEulerSdkForChain: async () => ({
  oracleAdapterService: { fetchOracleAdapterAssessment: mocks.single, fetchOracleAdapterAssessments: mocks.catalogue },
}) }))
vi.mock('~/composables/useOracleAdapterPrices', () => ({
  getOracleRouteStepKey: () => '',
  useOracleAdapterPrices: () => ({ prices: ref(new Map()), isLoading: ref(false) }),
}))

const ADAPTER = '0x0000000000000000000000000000000000000001'
const BASE = '0x0000000000000000000000000000000000000002'
const QUOTE = '0x0000000000000000000000000000000000000003'
const assessment = (provider: string) => ({
  chainId: 1, address: ADAPTER, recognized: true, checksStatus: 'positive', findings: [], provider,
})
const vault = {
  address: BASE, asset: { address: BASE }, collaterals: [], oracle: { oracle: ADAPTER },
  debtPricingOracleRoute: { steps: [{ kind: 'adapter', oracle: ADAPTER, base: BASE, quote: QUOTE }] },
} as unknown as EVault

let app: App | undefined
// Run the actual mounted setup/watchers without the unrelated presentation tree.
const mount = (component: Component, props: Record<string, unknown>) => {
  const renderer = createRenderer({
    patchProp: () => {}, insert: () => {}, remove: () => {},
    createElement: (type: string) => ({ type }), createText: (text: string) => ({ text }),
    createComment: (text: string) => ({ text }), setText: () => {}, setElementText: () => {},
    parentNode: () => null, nextSibling: () => null,
  })
  app = renderer.createApp({ render: () => h({ ...component, render: () => null }, props) })
  app.provide(ssrContextKey, {})
  app.mount({ type: 'root' })
}

beforeEach(() => {
  const config = useChainConfig()
  config.enabledChainIds.splice(0, config.enabledChainIds.length, 1, 999)
  vi.stubGlobal('useChainConfig', useChainConfig)
  vi.stubGlobal('useEnvConfig', () => ({ enableV3Backend: true, v3ImagesUrl: '' }))
  vi.stubGlobal('useEulerLabels', useEulerOracleAdapters)
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  vi.stubGlobal('useRoute', () => ({ hash: '' }))
  vi.stubGlobal('useEulerOracleRouters', () => ({
    recognizedRouters: ref(new Set()), recognizedRoutersChainId: ref(1), loadRecognizedRouters: mocks.routers,
  }))
  vi.stubGlobal('useTokenSymbolResolver', () => ({ buildKnownSymbols: () => new Map(), resolveSymbol: vi.fn(), shortenAddress: vi.fn() }))
  vi.stubGlobal('useClipboardCopy', () => ({ copyToClipboard: vi.fn() }))
  vi.stubGlobal('useUserSettings', () => ({ settings: ref({}) }))
  vi.stubGlobal('useRewardsApy', () => ({}))
  vi.stubGlobal('useTokenList', () => ({ getTokenCategoryTags: vi.fn() }))
  mocks.single.mockReset().mockResolvedValue(assessment('original'))
  mocks.catalogue.mockReset().mockResolvedValue([assessment('original')])
  mocks.routers.mockReset()
  applyChainReadPolicy(1, { deprecated: false, onchain: false, metadataOnly: false })
})
afterEach(() => {
  app?.unmount()
  vi.unstubAllGlobals()
})

describe.each(['overview', 'matrix'] as const)('mounted %s oracle assessments', (surface) => {
  const show = () => surface === 'overview'
    ? mount(VaultOverviewBlockOracleAdapters, { vault })
    : mount(DiscoveryMarketMatrix, { market: {}, matrix: {}, dotMetric: 'oracle', selectedCell: null, selectedHeader: null })

  it('reloads for deprecation, retirement and reactivation without a route or chain change', async () => {
    const adapters = useEulerOracleAdapters()
    const fetch = surface === 'overview' ? mocks.single : mocks.catalogue
    show()
    await vi.waitFor(() => expect(adapters.oracleAdapters[ADAPTER]?.provider).toBe('original'))
    applyChainReadPolicy(1, { deprecated: true, onchain: false, metadataOnly: false })
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2))
    expect(adapters.oracleAssessmentsStatus.value).toBe('available')
    applyChainReadPolicy(1, { deprecated: true, onchain: true, metadataOnly: true })
    await nextTick()
    expect(adapters.oracleAssessmentsStatus.value).toBe('unavailable')
    expect(adapters.oracleAdapters[ADAPTER]).toBeUndefined()
    expect(fetch).toHaveBeenCalledTimes(2)
    mocks.single.mockResolvedValue(assessment('reactivated'))
    mocks.catalogue.mockResolvedValue([assessment('reactivated')])
    applyChainReadPolicy(1, { deprecated: true, onchain: false, metadataOnly: false })
    await vi.waitFor(() => expect(adapters.oracleAdapters[ADAPTER]?.provider).toBe('reactivated'))
    expect(adapters.oracleAssessmentsStatus.value).toBe('available')
    applyChainReadPolicy(999, { deprecated: true, onchain: false, metadataOnly: false })
    await nextTick()
    expect(fetch).toHaveBeenCalledTimes(3)
  })

  it('starts an eligible load when cold policy resolves to the unchanged routing flags', async () => {
    useChainConfig().unresolvedChainIds!.push(1)
    const adapters = useEulerOracleAdapters()
    show()
    await nextTick()
    expect(adapters.oracleAssessmentsStatus.value).toBe('unavailable')
    expect(mocks.single).not.toHaveBeenCalled()
    expect(mocks.catalogue).not.toHaveBeenCalled()
    applyChainReadPolicy(1, { deprecated: false, onchain: false, metadataOnly: false })
    await vi.waitFor(() => expect(adapters.oracleAssessmentsStatus.value).toBe('available'))
    expect(adapters.oracleAdapters[ADAPTER]?.provider).toBe('original')
    if (surface === 'overview') expect(mocks.routers).toHaveBeenCalledTimes(2)
  })
})

it.each(['card', 'warning', 'evidence'])('reloads mounted vault %s assessments when policy changes without new labels', async (surface) => {
  const load = vi.fn()
  vi.stubGlobal('useEulerLabels', () => ({
    ...useEulerOracleAdapters(),
    isReady: ref(true), source: ref('v3'), vaultAssessments: ref({}),
    visibility: ref({ [BASE]: { status: 'warning', decidedBy: 'advisories' } }),
    loadVaultAssessment: load, getVaultAssessmentEntry: () => ({ status: 'idle' }),
    isVaultAssessmentAvailableForChain: () => true,
  }))
  vi.stubGlobal('useActivityNowMs', () => ref(Date.now()))
  vi.stubGlobal('useVaultReferences', () => ({ ensureResolved: vi.fn(), oracleLinkFor: vi.fn() }))
  vi.stubGlobal('useVaultCheckWeights', () => ({ weightOf: () => null }))
  if (surface === 'card') mount(VaultOverviewBlockVaultChecksCard, { address: BASE })
  else if (surface === 'warning') mount(VaultAssessmentWarning, { address: BASE, family: 'evk' })
  else mount(defineComponent({ setup: () => {
    useVaultAssessmentEvidence(BASE, 'evk')
    return () => null
  } }), {})
  expect(load).toHaveBeenCalledExactlyOnceWith(1, BASE, 'evk')
  applyChainReadPolicy(1, { deprecated: true, onchain: false, metadataOnly: false })
  await nextTick()
  expect(load).toHaveBeenCalledTimes(2)
})
