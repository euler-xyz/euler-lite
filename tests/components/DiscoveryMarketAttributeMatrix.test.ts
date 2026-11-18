import { createSSRApp, defineComponent, h, ref, type PropType } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, describe, expect, it, vi } from 'vitest'
import DiscoveryMarketAttributeMatrix from '~/components/entities/vault/discovery/DiscoveryMarketAttributeMatrix.vue'
import { getAttributeMatrix, getMarketVaultResolver, type VaultUsdCacheEntry } from '~/utils/discoveryCalculations'
import type { CollateralVaultResolver } from '~/utils/vault/collateral-exposure'
import type { VaultExposureDisplayItem } from '~/utils/vault/exposure-display'
import {
  EUSDC_42,
  EUSDC_42_OPEN_INTEREST_USD,
  EUSDC_42_TOTAL_SUPPLY_USD,
  makeLiquityHubOnDemandMarket,
} from '~/tests/fixtures/liquity-hub'

vi.mock('#components', () => ({ VaultHooksInfoModal: {} }))
vi.mock('~/composables/useTokenList', () => ({ getAssetLogoUrl: () => '' }))

const usdEntry = (supplyUsd: number): VaultUsdCacheEntry => ({
  supply: `$${supplyUsd}`,
  supplyUsd,
  supplyHasPrice: true,
  borrow: '-',
  borrowUsd: 0,
  liquidity: '-',
  liquidityUsd: 0,
  supplyCap: '-',
  supplyCapUsd: undefined,
  borrowCap: '-',
  borrowCapUsd: undefined,
})

const renderStatsMatrix = (resolveVault: CollateralVaultResolver) => {
  vi.stubGlobal('useVaults', () => ({ isVaultGovernorVerified: () => true }))
  vi.stubGlobal('useVaultRegistry', () => ({ getVaultCategory: () => 'standard' }))
  vi.stubGlobal('useCollateralOpenInterest', () => ({
    load: vi.fn(),
    getOpenInterestForVault: (address: string) => address.toLowerCase() === EUSDC_42.toLowerCase() ? EUSDC_42_OPEN_INTEREST_USD : {},
    hasError: ref(false),
    isLoaded: ref(true),
    isOpenInterestEnabled: ref(true),
  }))
  const market = makeLiquityHubOnDemandMarket()
  const app = createSSRApp({
    render: () => h(DiscoveryMarketAttributeMatrix, {
      data: getAttributeMatrix(market, 'stats'),
      view: 'stats',
      usdCache: new Map([[EUSDC_42.toLowerCase(), usdEntry(EUSDC_42_TOTAL_SUPPLY_USD)]]),
      apyCache: new Map(),
      badDebtCache: new Map(),
      showBadDebtColumn: false,
      selectedHeader: null,
      resolveVault,
    }),
  })
  app.component('VaultExposureSummary', defineComponent({
    props: { items: { type: Array as PropType<VaultExposureDisplayItem[]>, required: true }, valueState: String },
    setup: props => () => h('span', {
      'data-test-exposure': props.items.map(item => item.label ?? item.asset.symbol).join(',') || 'none',
      'data-test-state': props.valueState,
    }),
  }))
  return renderToString(app)
}

afterEach(() => vi.unstubAllGlobals())

describe('attribute matrix exposure on an on-demand market', () => {
  it('reads the collaterals of an unlisted product from its members', async () => {
    const market = makeLiquityHubOnDemandMarket()
    const html = await renderStatsMatrix(getMarketVaultResolver(market, () => undefined))

    expect(html).toContain('data-test-exposure="BOLD,sBOLD" data-test-state="ready"')
    expect(html).not.toContain('data-test-state="unavailable"')
  })

  it('reads Unavailable when the resolver cannot see the members', async () => {
    const html = await renderStatsMatrix(() => undefined)

    expect(html).toContain('data-test-exposure="none" data-test-state="unavailable"')
  })
})
