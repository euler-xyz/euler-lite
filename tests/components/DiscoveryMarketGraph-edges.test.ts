import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { MarketGroup, MiniDiagramData, MiniEdge, MiniNode } from '~/entities/lend-discovery'
import DiscoveryMarketGraph from '~/components/entities/vault/discovery/DiscoveryMarketGraph.vue'

vi.mock('~/utils/eulerLabelsUtils', async importOriginal => ({
  ...(await importOriginal<typeof import('~/utils/eulerLabelsUtils')>()),
  isVaultDeprecated: () => false,
  isVaultNotExplorable: () => false,
  getVaultDeprecation: () => ({ deprecated: false, reason: '' }),
  isVaultKeyring: () => false,
  isVaultCyclicalNote: () => false,
}))
vi.mock('~/composables/useTokenList', () => ({ getAssetLogoUrl: () => '' }))
vi.mock('~/composables/useDiscoveryVaultWarningDetails', () => ({
  useDiscoveryVaultWarningDetails: () => ({
    getWarningText: () => '',
    loadWarningDetails: vi.fn(),
    isAcceptedOnlyWarning: () => false,
  }),
}))

const GREY = 'var(--graph-edge)'
const GREEN = 'var(--accent-500)'
const A = '0x00000000000000000000000000000000000000aa'
const B = '0x00000000000000000000000000000000000000bb'
const C = '0x00000000000000000000000000000000000000cc'
const D = '0x00000000000000000000000000000000000000dd'

const node = (address: string, assetSymbol: string, x: number, y: number): MiniNode => ({
  address,
  assetAddress: '',
  assetSymbol,
  x,
  y,
  hasVaultData: true,
  isUnknown: false,
})
const nodes = [node(A, 'AAA', 30, 10), node(B, 'BBB', 50, 30), node(C, 'CCC', 30, 50), node(D, 'DDD', 10, 30)]
const edge = (from: number, to: number, mutual: boolean, borrowable: boolean): MiniEdge => ({
  from: nodes[from]!,
  to: nodes[to]!,
  mutual,
  borrowable,
})
const diagram: MiniDiagramData = {
  nodes,
  edges: [edge(0, 1, true, true), edge(2, 0, false, false), edge(3, 1, false, true)],
  pairCount: 3,
  assetCount: 4,
  viewWidth: 60,
}
const market = {
  id: 'edges',
  name: 'Edges',
  source: 'product',
  vaults: nodes.map(({ address, assetSymbol }) => ({
    address,
    chainId: 1,
    asset: { address, symbol: assetSymbol },
  })),
  externalCollateral: [],
  unknownCollateral: [],
} as unknown as MarketGroup

const render = (selectedNodeAddress: string | null) => {
  vi.stubGlobal('useVaults', () => ({
    isVaultGovernorVerified: () => true,
    isSecuritizeGovernorVerified: () => true,
    isEarnVaultOwnerVerified: () => true,
  }))
  vi.stubGlobal('useEulerLabels', () => ({
    isReady: ref(true),
    source: ref('v3'),
    visibility: ref({}),
  }))
  const app = createSSRApp({ render: () => h(DiscoveryMarketGraph, { market, diagram, selectedNodeAddress }) })
  app.component('UiHoverPreviewTooltip', defineComponent({
    setup: (_props, { slots }) => () => h('div', slots.default?.()),
  }))
  return renderToString(app)
}

const attribute = (element: string, name: string): string | null =>
  new RegExp(`\\s${name}="([^"]*)"`).exec(element)?.[1] ?? null
const lines = (html: string) => html.match(/<line[^>]*>/g) ?? []
const line = (html: string, from: string, to: string) => {
  const found = lines(html).find(element =>
    attribute(element, 'data-from-address') === from && attribute(element, 'data-to-address') === to)
  if (!found) throw new Error(`No line from ${from} to ${to}`)
  return found
}
const arrowheads = (html: string) =>
  (html.match(/<polygon[^>]*>/g) ?? []).map(element => element.includes(GREEN) ? GREEN : GREY)

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('discovery graph edges', () => {
  it('draws every line one grey, without arrowheads, while no vault is selected', async () => {
    const html = await render(null)
    expect(lines(html)).toHaveLength(3)
    for (const element of lines(html)) {
      expect(element).toContain(`stroke:${GREY}`)
      expect(attribute(element, 'opacity')).toBe('0.9')
    }
    expect(arrowheads(html)).toEqual([])
  })

  it('makes a two-way line thicker than a one-way line, selected or not', async () => {
    for (const selected of [null, A]) {
      const html = await render(selected)
      expect(attribute(line(html, A, B), 'stroke-width')).toBe('1')
      expect(attribute(line(html, C, A), 'stroke-width')).toBe('0.5')
      expect(attribute(line(html, D, B), 'stroke-width')).toBe('0.5')
    }
  })

  it('turns green only what goes into or out of the selected vault, with one line per pair', async () => {
    const html = await render(A)
    expect(lines(html)).toHaveLength(3)
    expect(line(html, A, B)).toContain(`stroke:${GREEN}`)
    expect(line(html, C, A)).toContain(`stroke:${GREEN}`)
    expect(line(html, D, B)).toContain(`stroke:${GREY}`)
    expect(attribute(line(html, D, B), 'opacity')).toBe('0.15')
    expect(arrowheads(html)).toEqual([GREEN, GREEN, GREEN])
  })

  it('dashes a line only when no direction can be borrowed against', async () => {
    const html = await render(A)
    expect(attribute(line(html, A, B), 'stroke-dasharray')).toBeNull()
    expect(attribute(line(html, D, B), 'stroke-dasharray')).toBeNull()
    expect(attribute(line(html, C, A), 'stroke-dasharray')).toBe('5 4')
  })
})
