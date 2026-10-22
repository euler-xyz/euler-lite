import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarketGroup, MiniDiagramData } from '~/entities/lend-discovery'
import DiscoveryMarketGraph from '~/components/entities/vault/discovery/DiscoveryMarketGraph.vue'

const address = '0x00000000000000000000000000000000000000aa'
const labels = vi.hoisted(() => ({ deprecated: true, unlisted: false }))

vi.mock('~/utils/eulerLabelsUtils', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/eulerLabelsUtils')>()),
  isVaultDeprecated: () => labels.deprecated,
  isVaultNotExplorable: () => labels.unlisted,
  getVaultDeprecation: () => labels.deprecated
    ? { deprecated: true, reason: 'Migrate to the new sUSDe vault.' }
    : { deprecated: false, reason: '' },
  isVaultKeyring: () => false,
  isVaultCyclicalNote: () => false,
}))
vi.mock('~/composables/useTokenList', () => ({ getAssetLogoUrl: () => '' }))
vi.mock('~/composables/useDiscoveryVaultWarningDetails', () => ({
  useDiscoveryVaultWarningDetails: () => ({
    getWarningText: (_vault: unknown, fallback?: string | null) => fallback || 'Vault checks need review',
    loadWarningDetails: vi.fn(),
    isAcceptedOnlyWarning: () => false,
  }),
}))

const node = { address, assetAddress: '', assetSymbol: 'sUSDe', x: 30, y: 30, hasVaultData: true, isUnknown: false }
const diagram: MiniDiagramData = { nodes: [node], edges: [], pairCount: 0, assetCount: 1, viewWidth: 60 }
const market = {
  id: 'k3',
  name: 'K3 Stablecoin Cluster',
  source: 'product',
  vaults: [{ address, chainId: 1, asset: { address: '0x00000000000000000000000000000000000000bb', symbol: 'sUSDe' } }],
  externalCollateral: [],
  unknownCollateral: [],
} as unknown as MarketGroup

const renderGraph = (verdict: { status: string, decidedBy: string, reason: string | null }, deprecatedInLabels: boolean) => {
  labels.deprecated = deprecatedInLabels
  vi.stubGlobal('useVaults', () => ({
    isVaultGovernorVerified: () => true,
    isSecuritizeGovernorVerified: () => true,
    isEarnVaultOwnerVerified: () => true,
  }))
  vi.stubGlobal('useEulerLabels', () => ({
    isReady: ref(true),
    source: ref('v3'),
    visibility: ref({ [address]: verdict }),
  }))
  const app = createSSRApp({ render: () => h(DiscoveryMarketGraph, { market, diagram, selectedNodeAddress: null }) })
  app.component('UiHoverPreviewTooltip', defineComponent({
    props: { title: String, text: String },
    setup: (props, { slots }) => () => h('div', { 'data-title': props.title, 'data-text': props.text }, slots.default?.()),
  }))
  return renderToString(app)
}

afterEach(() => {
  labels.unlisted = false
  vi.unstubAllGlobals()
})

describe('graph node badge for unlisted vaults', () => {
  it('marks a vault hidden from both tables as Unlisted', async () => {
    labels.unlisted = true
    const html = await renderGraph({ status: 'visible', decidedBy: 'verified', reason: null }, false)
    expect(html).toContain('data-title="Unlisted"')
    expect(html).toContain('data-text="Hidden from the lend and borrow tables."')
  })

  it('prefers the Deprecated badge for a deprecated vault', async () => {
    labels.unlisted = true
    const html = await renderGraph({ status: 'warning', decidedBy: 'deprecated', reason: null }, true)
    expect(html).toContain('data-title="Deprecated"')
    expect(html).not.toContain('data-title="Unlisted"')
  })

  it('shows no listing badge for a listed vault', async () => {
    const html = await renderGraph({ status: 'visible', decidedBy: 'verified', reason: null }, false)
    expect(html).not.toContain('data-title="Unlisted"')
  })
})

describe('graph node badge for deprecated vaults', () => {
  it('shows the Deprecated badge with the reason instead of a vault-checks warning', async () => {
    const html = await renderGraph({ status: 'warning', decidedBy: 'deprecated', reason: null }, true)
    expect(html).toContain('data-title="Deprecated"')
    expect(html).toContain('data-text="Migrate to the new sUSDe vault."')
    expect(html).not.toContain('data-title="Vault checks"')
  })

  it('keeps the vault-checks warning when labels do not carry the deprecation', async () => {
    const html = await renderGraph({ status: 'warning', decidedBy: 'deprecated', reason: null }, false)
    expect(html).toContain('data-title="Vault checks"')
    expect(html).not.toContain('data-title="Deprecated"')
  })

  it('keeps vault-checks warnings that are not decided by deprecation', async () => {
    const html = await renderGraph({ status: 'warning', decidedBy: 'assessment', reason: 'Review the oracle.' }, true)
    expect(html).toContain('data-title="Vault checks"')
    expect(html).toContain('data-text="Review the oracle."')
  })
})
