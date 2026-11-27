import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import DiscoveryMarketMatrix from '~/components/entities/vault/discovery/DiscoveryMarketMatrix.vue'
import { getCollateralMatrix } from '~/utils/discoveryCalculations'
import {
  BOLD,
  EBOLD_1,
  ESBOLD_1,
  NO_OPERATIONS_HOOKED,
  SBOLD,
  USDC,
  makeLiquityHubOnDemandMarket,
  makeLiquityHubVaults,
} from '~/tests/fixtures/liquity-hub'

vi.mock('~/composables/useTokenList', () => ({ getAssetLogoUrl: () => '' }))

const USD_TOKENS = new Set([USDC.address, BOLD.address, SBOLD.address].map(address => address.toLowerCase()))

const render = async (vaults: EVault[], dotMetric: 'roe' | 'multiplier') => {
  const market = makeLiquityHubOnDemandMarket(vaults.map(vault => Object.assign(vault, {
    interestRates: { supplyAPY: vault.asset.symbol === 'sBOLD' ? 8 : 3, borrowAPY: 4 },
  })))
  const matrix = getCollateralMatrix(market)
  const app = createSSRApp({
    render: () => h(DiscoveryMarketMatrix, { market, matrix, dotMetric, selectedCell: null, selectedHeader: null }),
  })
  app.component('UiHoverPreviewTooltip', defineComponent({
    props: { title: String, text: String },
    setup: (props, { slots }) => () => h('span', { 'data-test-tooltip': props.title, 'data-test-text': props.text }, slots.default?.()),
  }))
  for (const name of ['SvgIcon', 'BaseAvatar', 'AssetAvatar']) app.component(name, { render: () => h('span') })
  return renderToString(app)
}

const cell = (html: string, collateral: string, liability: string) => {
  const key = `data-key="${collateral.toLowerCase()}:${liability.toLowerCase()}"`
  const start = html.indexOf(key)
  return start < 0 ? '' : html.slice(start, html.indexOf('</td>', start))
}

beforeEach(() => {
  vi.stubGlobal('useUserSettings', () => ({ settings: ref({ enableIntrinsicApy: false, enableRewardsApy: false }) }))
  vi.stubGlobal('useRewardsApy', () => ({
    getBorrowRewardApy: () => 0,
    getSupplyRewardApy: () => 0,
    getLoopingRewardApy: () => 0,
    hasSupplyRewards: () => false,
    hasBorrowRewards: () => false,
  }))
  vi.stubGlobal('useEulerLabels', () => ({
    oracleAdapters: {},
    oracleAssessmentsStatus: ref('idle'),
    oracleAssessmentsAvailable: ref(false),
    loadAllOracleAdapters: vi.fn(),
  }))
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
  vi.stubGlobal('useEnvConfig', () => ({ v3ImagesUrl: '' }))
  vi.stubGlobal('useTokenList', () => ({
    getTokenCategoryTags: (address: string) => USD_TOKENS.has(address.toLowerCase()) ? ['usd'] : [],
  }))
  vi.stubGlobal('ltvToPercent', (ltv: number) => ltv * 100)
  vi.stubGlobal('getVaultSupplyApy', (vault: EVault) => vault.interestRates.supplyAPY)
  vi.stubGlobal('getVaultBorrowApy', (vault: EVault) => vault.interestRates.borrowAPY)
})

afterEach(() => vi.unstubAllGlobals())

describe('pair matrix on a paused product', () => {
  it.each(['roe', 'multiplier'] as const)('shows the paused reason as a tooltip on a paused %s cell', async (metric) => {
    const html = cell(await render(makeLiquityHubVaults(), metric), ESBOLD_1, EBOLD_1)

    expect(html).toContain('data-test-tooltip="Pair paused"')
    expect(html).toContain('data-test-text="This pair is paused: the liability does not lend or the collateral does not take deposits."')
    expect(html).toContain('aria-label="This pair is paused: the liability does not lend or the collateral does not take deposits."')
  })

  it('leaves live numeric cells as they are', async () => {
    const html = cell(await render(makeLiquityHubVaults({ hookedOperations: NO_OPERATIONS_HOOKED }), 'roe'), ESBOLD_1, EBOLD_1)

    expect(html).not.toContain('data-test-tooltip')
    expect(html).toMatch(/data-value="\d/)
  })
})
