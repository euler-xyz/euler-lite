import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarketGroup, MiniDiagramData } from '~/entities/lend-discovery'
import type { VaultVerdictLike } from '~/utils/vault-assessment/flagged'
import DiscoveryMarketGraph from '~/components/entities/vault/discovery/DiscoveryMarketGraph.vue'

const address = '0x00000000000000000000000000000000000000aa'
const labels = vi.hoisted(() => ({ deprecated: true }))
const warnings = vi.hoisted(() => ({ text: '', acceptedOnly: false }))

vi.mock('~/utils/eulerLabelsUtils', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/eulerLabelsUtils')>()),
  isVaultDeprecated: () => labels.deprecated,
  getVaultDeprecation: () => labels.deprecated
    ? { deprecated: true, reason: 'Migrate to the new sUSDe vault.' }
    : { deprecated: false, reason: '' },
  isVaultKeyring: () => false,
  isVaultCyclicalNote: () => false,
}))
vi.mock('~/composables/useTokenList', () => ({ getAssetLogoUrl: () => '' }))
vi.mock('~/composables/useDiscoveryVaultWarningDetails', () => ({
  useDiscoveryVaultWarningDetails: () => ({
    getWarningText: (_vault: unknown, fallback?: string | null) => warnings.text || fallback || 'Vault checks need review',
    loadWarningDetails: vi.fn(),
    isAcceptedOnlyWarning: () => warnings.acceptedOnly,
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

const renderGraph = (
  verdict: VaultVerdictLike | undefined,
  deprecatedInLabels: boolean,
  options: { ready?: boolean, source?: 'v3' | 'v3-metadata' | 'static', warningText?: string, acceptedOnly?: boolean } = {},
) => {
  labels.deprecated = deprecatedInLabels
  warnings.text = options.warningText ?? ''
  warnings.acceptedOnly = options.acceptedOnly ?? false
  vi.stubGlobal('useVaults', () => ({
    isVaultGovernorVerified: () => true,
    isSecuritizeGovernorVerified: () => true,
    isEarnVaultOwnerVerified: () => true,
  }))
  vi.stubGlobal('useEulerLabels', () => ({
    isReady: ref(options.ready ?? true),
    source: ref(options.source ?? 'v3'),
    visibility: ref({ [address]: verdict }),
  }))
  const app = createSSRApp({ render: () => h(DiscoveryMarketGraph, { market, diagram, selectedNodeAddress: null }) })
  app.component('UiHoverPreviewTooltip', defineComponent({
    props: { title: String, text: String },
    setup: (props, { slots }) => () => h('div', { 'data-title': props.title, 'data-text': props.text }, slots.default?.()),
  }))
  return renderToString(app)
}

afterEach(() => vi.unstubAllGlobals())

describe('graph node badge for deprecated vaults', () => {
  it('uses the effective platform deprecation reason in one Deprecated badge', async () => {
    const html = await renderGraph({ status: 'warning', decidedBy: 'deprecated', reason: '  Euler has decommissioned this vault.  ' }, true)
    expect(html.match(/data-title="Deprecated"/g)).toHaveLength(1)
    expect(html).toContain('data-text="Euler has decommissioned this vault."')
    expect(html).not.toContain('Migrate to the new sUSDe vault.')
    expect(html).not.toContain('data-title="Vault checks"')
  })

  it.each([null, undefined, '', '   '])('falls back to the label reason when the effective reason is %j', async (reason) => {
    const html = await renderGraph({ status: 'warning', decidedBy: 'deprecated', reason }, true)
    expect(html).toContain('data-title="Deprecated"')
    expect(html).toContain('data-text="Migrate to the new sUSDe vault."')
    expect(html).not.toContain('data-title="Vault checks"')
  })

  it.each(['static', 'v3-metadata'] as const)('uses the label reason for a %s source', async (source) => {
    const html = await renderGraph({ status: 'warning', decidedBy: 'deprecated', reason: 'Stale V3 reason.' }, true, { source })
    expect(html).toContain('data-title="Deprecated"')
    expect(html).toContain('data-text="Migrate to the new sUSDe vault."')
    expect(html).not.toContain('Stale V3 reason.')
    expect(html).not.toContain('data-title="Vault checks"')
  })

  it('uses the label reason while V3 labels are not ready', async () => {
    const html = await renderGraph({ status: 'warning', decidedBy: 'deprecated', reason: 'Stale V3 reason.' }, true, { ready: false })
    expect(html).toContain('data-title="Deprecated"')
    expect(html).toContain('data-text="Migrate to the new sUSDe vault."')
    expect(html).not.toContain('Stale V3 reason.')
    expect(html).not.toContain('data-title="Vault checks"')
  })

  it('keeps label-only deprecation when no verdict exists', async () => {
    const html = await renderGraph(undefined, true)
    expect(html).toContain('data-title="Deprecated"')
    expect(html).toContain('data-text="Migrate to the new sUSDe vault."')
    expect(html).not.toContain('data-title="Vault checks"')
  })

  it('keeps the verdict and its reason when labels do not carry the deprecation', async () => {
    const html = await renderGraph({ status: 'warning', decidedBy: 'deprecated', reason: 'Euler has decommissioned this vault.' }, false)
    expect(html).toContain('data-title="Vault checks"')
    expect(html).toContain('data-text="Euler has decommissioned this vault."')
    expect(html).not.toContain('data-title="Deprecated"')
  })

  it.each([
    { status: 'warning', decidedBy: 'assessment' },
    { status: 'hidden', decidedBy: 'config-failed' },
  ])('keeps $status/$decidedBy vault checks even with deprecated labels', async (verdict) => {
    const html = await renderGraph({ ...verdict, reason: 'Review the oracle.' }, true)
    expect(html).toContain('data-title="Vault checks"')
    expect(html).toContain('data-text="Review the oracle."')
    expect(html).not.toContain('data-title="Deprecated"')
  })

  it('does not use an unrelated verdict reason for the Deprecated tooltip', async () => {
    const html = await renderGraph({ status: 'pending_review', decidedBy: 'awaiting-verification', reason: 'An unrelated review reason.' }, true)
    expect(html).toContain('data-title="Deprecated"')
    expect(html).toContain('data-text="Migrate to the new sUSDe vault."')
    expect(html).not.toContain('An unrelated review reason.')
  })

  it('keeps the single Deprecated badge when advisory findings also exist', async () => {
    const html = await renderGraph({ status: 'warning', decidedBy: 'deprecated', reason: 'Euler has decommissioned this vault.' }, true, { warningText: 'A liquidation discount advisory needs review.' })
    expect(html.match(/data-title="Deprecated"/g)).toHaveLength(1)
    expect(html).toContain('data-text="Euler has decommissioned this vault."')
    expect(html).not.toContain('data-title="Vault checks"')
    expect(html).not.toContain('A liquidation discount advisory needs review.')
  })

  it('keeps accepted-only advisory warnings suppressed', async () => {
    const html = await renderGraph({ status: 'warning', decidedBy: 'advisories', reason: 'An accepted advisory.' }, false, { acceptedOnly: true })
    expect(html).not.toContain('data-title="Vault checks"')
    expect(html).not.toContain('data-title="Deprecated"')
  })
})
