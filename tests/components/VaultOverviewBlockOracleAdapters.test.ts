import { computed, createSSRApp, defineComponent, h, ref, type ComputedRef } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EVault, OracleRouteStep } from '@eulerxyz/euler-v2-sdk'
import type { OracleAssessmentsStatus } from '~/composables/useEulerOracleAdapters'
import type { AdapterPriceInfo } from '~/composables/useOracleAdapterPrices'
import VaultOverviewBlockOracleAdapters from '~/components/entities/vault/overview/VaultOverviewBlockOracleAdapters.vue'

vi.mock('#components', () => ({ OracleAdapterChecksModal: {} }))
vi.mock('~/composables/useOracleAdapterPrices', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/composables/useOracleAdapterPrices')>()
  return {
    ...actual,
    useOracleAdapterPrices: (steps: ComputedRef<OracleRouteStep[]>) => {
      quotedSteps = steps
      return { prices, isLoading: priceLoading }
    },
  }
})

const ADAPTER = '0x0000000000000000000000000000000000000001'
const BASE = '0x0000000000000000000000000000000000000002'
const QUOTE = '0x0000000000000000000000000000000000000003'
const step: OracleRouteStep = { kind: 'adapter', oracle: ADAPTER, base: BASE, quote: QUOTE, name: 'SpoofedProvider' }
const status = ref<OracleAssessmentsStatus>('unavailable')
const priceLoading = ref(false)
const prices = ref(new Map<string, AdapterPriceInfo>())
let quotedSteps: ComputedRef<OracleRouteStep[]>

const vaultWith = (steps: OracleRouteStep[] = [step]) => ({
  address: BASE,
  asset: { address: BASE, symbol: 'WETH', decimals: 18 },
  shares: { decimals: 18 },
  unitOfAccount: { address: QUOTE, symbol: 'USD', decimals: 18 },
  debtPricingOracleRoute: { steps },
  collaterals: [],
  oracle: { oracle: ADAPTER },
} as unknown as EVault)

const render = (steps: OracleRouteStep[] = [step]) => {
  const app = createSSRApp({ render: () => h(VaultOverviewBlockOracleAdapters, { vault: vaultWith(steps) }) })
  const passthrough = defineComponent({
    setup: (_, { slots }) => () => h('div', [slots.actions?.(), slots.default?.()]),
  })
  for (const name of ['VaultOverviewAccordionSection', 'UiHoverPreviewTooltip', 'UiModalPreviewTrigger']) {
    app.component(name, passthrough)
  }
  app.component('NuxtLink', defineComponent({
    props: ['to'],
    setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()),
  }))
  app.component('BaseAvatar', defineComponent({
    props: ['label'],
    setup: props => () => h('img', { alt: props.label }),
  }))
  app.component('SvgIcon', defineComponent({
    props: ['name'],
    setup: props => () => h('svg', { 'data-icon': props.name }),
  }))
  return renderToString(app)
}

beforeEach(() => {
  status.value = 'unavailable'
  priceLoading.value = false
  prices.value = new Map([['adapter:' + ADAPTER + ':' + BASE + ':' + QUOTE, { rate: 3000, success: true }]])
  vi.stubGlobal('useEulerLabels', () => ({
    oracleAssessmentsStatus: status,
    oracleAssessmentsAvailable: computed(() => status.value === 'available'),
    // A retained recognized assessment must not leak into the unavailable view.
    oracleAdapters: {
      [ADAPTER]: {
        oracle: ADAPTER, recognized: true, name: 'Trusted adapter', provider: 'Chainlink',
        label: 'Curated feed', methodology: 'Market price', checksStatus: 'positive',
        base: QUOTE, quote: BASE, checks: [], inActiveRoute: true,
      },
    },
    loadOracleAdapters: vi.fn(),
  }))
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  vi.stubGlobal('useEnvConfig', () => ({ v3ImagesUrl: 'https://images.example' }))
  vi.stubGlobal('useEulerOracleRouters', () => ({
    recognizedRouters: ref(new Set()), recognizedRoutersChainId: ref(1), loadRecognizedRouters: vi.fn(),
  }))
  vi.stubGlobal('useTokenSymbolResolver', () => ({
    buildKnownSymbols: () => new Map(),
    resolveSymbol: (address: string) => address === BASE ? 'WETH' : 'USD',
    shortenAddress: (address: string) => address,
  }))
  vi.stubGlobal('useClipboardCopy', () => ({ copyToClipboard: vi.fn().mockResolvedValue(undefined) }))
})
afterEach(() => vi.unstubAllGlobals())

describe('oracle details without V3 assessments', () => {
  it('shows the route, linked address and routed quote without cached or self-reported identity', async () => {
    const html = await render()
    expect(html).toContain('Oracle verification unavailable')
    expect(html).toContain('WETH/USD')
    expect(html).toContain('href="https://etherscan.io/address/' + ADAPTER + '"')
    expect(html).toContain('Copy adapter address')
    expect(html).toContain('1 WETH = 3,000.00 USD')
    expect(quotedSteps.value).toEqual([step])
    for (const hidden of ['SpoofedProvider', 'Chainlink', 'Curated feed', 'Methodology', 'Checks', '<img', 'Unrecognized router']) {
      expect(html).not.toContain(hidden)
    }
  })

  it('keeps route and address visible when the quote fails', async () => {
    prices.value = new Map()
    const html = await render()
    expect(html).toContain('Quote unavailable')
    expect(html).toContain(ADAPTER)
    expect(html).toContain('WETH/USD')
    expect(html).not.toContain('1 WETH =')
  })

  it('distinguishes a pending quote from a failed quote', async () => {
    priceLoading.value = true
    const html = await render()
    expect(html).toContain('animate-pulse')
    expect(html).not.toContain('Quote unavailable')
    expect(html).not.toContain('1 WETH =')
  })

  it('identifies structural route addresses without displaying their decoded name or logo', async () => {
    const vaultStep: OracleRouteStep = {
      kind: 'vault', oracle: ADAPTER, base: BASE, quote: QUOTE,
      name: 'ERC4626Vault', vault: ADAPTER, asset: QUOTE,
    }
    const html = await render([vaultStep])
    expect(html).toContain('Vault address')
    expect(html).toContain('Copy vault address')
    expect(html).not.toContain('ERC4626Vault')
    expect(html).not.toContain('<img')
  })

  it('shows an explicit empty state when the SDK cannot resolve route steps', async () => {
    const html = await render([])
    expect(html).toContain('Oracle verification unavailable')
    expect(html).toContain('Route information not available')
    expect(html).not.toContain('data-id="oracle-route-fallback"')
  })

  it('preserves the assessed view when V3 is available', async () => {
    status.value = 'available'
    const html = await render()
    expect(html).toContain('Curated feed')
    expect(html).toContain('Chainlink')
    expect(html).toContain('Methodology')
    expect(html).toContain('Checks')
    expect(html).not.toContain('data-id="oracle-fallback"')
    expect(html).not.toContain('SpoofedProvider')
  })

  it('does not classify initial assessment loading as unavailable', async () => {
    status.value = 'loading'
    const html = await render()
    expect(html).not.toContain('data-id="oracle-fallback"')
    expect(quotedSteps.value).toEqual([])
  })
})
