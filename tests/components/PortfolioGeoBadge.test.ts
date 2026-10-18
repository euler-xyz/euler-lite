import { renderToString } from '@vue/server-renderer'
import { createSSRApp, h, ref, type Component } from 'vue'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import PortfolioBorrowItem from '~/components/entities/portfolio/PortfolioBorrowItem.vue'
import PortfolioSavingItem from '~/components/entities/portfolio/PortfolioSavingItem.vue'
import PortfolioEarnItem from '~/components/entities/portfolio/PortfolioEarnItem.vue'
import { __setEulerLabelsDataForTest } from '~/composables/useEulerLabels'
import { useGeoBlock } from '~/composables/useGeoBlock'
import { staticGeoLabels } from '~/tests/fixtures/static-geo-labels'

const registry = vi.hoisted(() => ({ getVault: vi.fn<(address: string) => { chainId: number } | undefined>(() => undefined), getVaultCategory: () => 'standard', isVerifiedVault: () => false }))
vi.mock('~/composables/useVaultRegistry', () => ({ useVaultRegistry: () => registry }))
vi.mock('~/composables/useEulerLabels', async original => ({
  ...await original<typeof import('~/composables/useEulerLabels')>(),
  useEulerProductOfVault: () => ({ name: 'Unlisted vault' }),
}))
vi.mock('#components', () => ({ VaultOverviewModal: {}, VaultApyModal: {}, VaultNetApyModal: {}, PortfolioRoeModal: {}, UiModalPreviewTrigger: { template: '<span><slot /></span>' } }))
vi.mock('~/components/ui/composables/useModal', () => ({ useModal: () => ({ open: vi.fn() }) }))
vi.mock('~/composables/useVaultWarnings', () => ({ getUtilisationWarning: () => null }))
vi.mock('~/utils/sdk-prices', () => ({ toUsdAmount: () => ({ hasPrice: true, usd: 10 }), getAssetUsdValue: async () => 10, formatAssetValue: async () => ({ hasPrice: true, usdValue: 10 }) }))
vi.mock('~/entities/account', () => ({ getPositionRampStatus: () => ({ isRamping: false, forcedLiquidationAt: null }), getPositionRampTargetTimestamp: () => null }))
vi.mock('~/utils/ltv', () => ({ getBorrowPositionEffectiveLiquidationLTV: () => 0.86, getBorrowPositionUserLTVPercent: () => 50 }))
vi.mock('~/utils/position-roe', () => ({ areRoeCollateralVaultsCorrelatedWithBorrow: () => false }))
vi.mock('~/utils/vault-intrinsic-apy', () => ({ withVaultIntrinsicApy: () => 0, getVaultIntrinsicApy: () => 0, getVaultIntrinsicApyInfo: () => ({}) }))
vi.mock('@eulerxyz/euler-v2-sdk', async original => ({
  ...await original<typeof import('@eulerxyz/euler-v2-sdk')>(), computeSupplyApyBreakdown: () => ({}),
}))
const chainId = ref(1)
const vault = { type: 'EVault', address: '0x63bA834bFf27Dd1d80533a56cA27Aa058AAA1130', chainId: 1, shares: { name: 'Cozy', decimals: 6 }, asset: { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48', symbol: 'USDC', name: 'USD Coin', decimals: 6 } }
const position = {
  subAccount: '0x9Db3e0FBd969ec2468C8d9f85440dC5595CE1FD8', vault, assets: 1n,
  borrowVault: vault, collateralVault: vault, collateralVaults: [vault.address], collaterals: [{ vault, assets: 1n }],
  supplied: 1n, borrowed: 1n, borrow: { liquidity: {} }, healthFactor: 2n * 10n ** 18n,
  getApyBreakdown: () => ({}), getRoeBreakdown: () => ({}),
}
const render = async (component: Component) => {
  const app = createSSRApp({ render: () => h(component, { position, clickable: false }) })
  app.config.warnHandler = () => {}
  app.config.globalProperties.$route = { query: { network: '1' }, params: {}, path: '/', fullPath: '/', hash: '', name: 'test', matched: [], meta: {}, redirectedFrom: undefined }
  app.component('UiHoverPreviewTooltip', { template: '<span><slot /></span>' })
  return renderToString(app)
}
beforeEach(() => {
  chainId.value = 1
  registry.getVault.mockReturnValue(undefined)
  useGeoBlock().country.value = 'NL'
  __setEulerLabelsDataForTest({ geoContext: { chainId: 1, policies: [], productByVault: {} } })
  vi.stubGlobal('useEulerAddresses', () => ({ chainId }))
  vi.stubGlobal('useVaultRegistry', () => registry)
  vi.stubGlobal('useEulerProductOfVault', () => ({ name: 'Unlisted vault' }))
  vi.stubGlobal('useEulerAccount', () => ({ portfolioAddress: ref('0x9Db3e0FBd969ec2468C8d9f85440dC5595CE1FD9') }))
  vi.stubGlobal('useTxBatch', () => ({ modifiedKeys: ref(new Set()), removedKeys: ref(new Set()) }))
  vi.stubGlobal('useUserSettings', () => ({ settings: ref({ enableIntrinsicApy: false, enableRewardsApy: false }) }))
  vi.stubGlobal('useApyVisibility', () => ({ viewer: ref('all'), visibleBreakdown: () => ({}), visibleTotal: () => 0 }))
  vi.stubGlobal('useTokenList', () => ({ getTokenCategoryTags: () => [] }))
  vi.stubGlobal('useRewardsApy', () => new Proxy({}, { get: () => () => 0 }))
  for (const key of ['getVaultSupplyApy', 'getVaultBorrowApy', 'ltvToPercent']) vi.stubGlobal(key, () => 0)
})
describe.each(['hosted', 'static'] as const)('%s labels', (source) => {
  beforeEach(() => {
    if (source === 'static') __setEulerLabelsDataForTest(staticGeoLabels())
  })

  describe.each([
    ['borrow', PortfolioBorrowItem], ['saving', PortfolioSavingItem], ['earn', PortfolioEarnItem],
  ] as const)('%s portfolio badge', (_name, component) => {
    it('does not turn missing registry membership into a region badge', async () => {
      expect(await render(component)).not.toContain('Restricted')
    })
    it('does not label missing country as a confirmed restriction', async () => {
      useGeoBlock().country.value = null
      expect(await render(component)).not.toContain('Restricted')
    })
    it('does not use stale chain metadata as a restriction', async () => {
      chainId.value = 8453
      __setEulerLabelsDataForTest(source === 'static'
        ? staticGeoLabels({ assets: [{ address: vault.asset.address, block: ['NL'] }] })
        : { geoContext: { chainId: 8453, policies: [{ id: 'other-chain', chainId: 8453, productId: null, vaultAddress: null, assetAddress: vault.asset.address, policyType: 'block', countries: ['NL'], countriesResolved: ['NL'], reason: null, createdAt: '' }], productByVault: {} } })
      registry.getVault.mockReturnValue({ ...vault, chainId: 8453 })
      expect(await render(component)).not.toContain('Restricted')
    })
    it('displays an authored asset block without discovery membership', async () => {
      __setEulerLabelsDataForTest(source === 'static'
        ? staticGeoLabels({ assets: [{ address: vault.asset.address, block: ['EEA'] }] })
        : { geoContext: { chainId: 1, policies: [{ id: 'asset', chainId: 1, productId: null, vaultAddress: null, assetAddress: vault.asset.address, policyType: 'block', countries: ['NL'], countriesResolved: ['NL'], reason: null, createdAt: '' }], productByVault: {} } })
      expect(await render(component)).toContain('Restricted')
    })
    it('still displays actual geographic restrictions', async () => {
      useGeoBlock().country.value = 'IR'
      expect(await render(component)).toContain('Restricted')
    })
  })
})
