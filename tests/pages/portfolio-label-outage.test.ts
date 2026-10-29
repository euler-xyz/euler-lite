import { renderToString } from '@vue/server-renderer'
import { createSSRApp, defineComponent, h, onActivated, onDeactivated, ref, type Component, type PropType } from 'vue'
import { afterEach, describe, expect, it, vi } from 'vitest'
import PortfolioPage from '~/pages/portfolio.vue'
import PositionsPage from '~/pages/portfolio/index.vue'
import DepositsPage from '~/pages/portfolio/saving.vue'
import RewardsPage from '~/pages/portfolio/rewards.vue'
import LabelsUnavailableState from '~/components/entities/LabelsUnavailableState.vue'
import UiEmptyState from '~/components/ui/UiEmptyState.vue'
import { useVisibleTicker } from '~/composables/useVisibleTicker'
import {
  shouldLeavePortfolioActivityRoute,
  shouldShowPortfolioActivityTab,
} from '~/composables/usePortfolioActivityRuntimeSupport'

vi.mock('~/composables/useExternalMigrationPositions', () => ({ isExternalMigrationDustPosition: () => false }))
vi.mock('~/utils/sdk-prices', () => ({ getAssetUsdValueOrZero: async () => 0 }))

const renderPortfolio = async (child: Component, routeName: string, labelsReady = false) => {
  vi.stubGlobal('useRoute', () => ({ name: routeName, query: { network: '1' } }))
  vi.stubGlobal('useRouter', () => ({ replace: vi.fn() }))
  vi.stubGlobal('useEulerAccount', () => ({
    borrowPositions: ref([]), removedBorrowPositions: ref([]),
    depositPositions: ref([]), removedDepositPositions: ref([]),
    totalSuppliedValueInfo: ref({ total: 0, hasMissingPrices: false }),
    totalBorrowedValueInfo: ref({ total: 0, hasMissingPrices: false }),
    netAssetMarketValueInfo: ref({ total: 0, hasMissingPrices: false }),
    portfolioRoe: ref(0), portfolioNetApy: ref(0), portfolioAddress: ref(undefined),
    isPositionsLoaded: ref(true), isDepositsLoaded: ref(true), isShowAllPositions: ref(false),
    refreshAllPositions: vi.fn(),
  }))
  vi.stubGlobal('useEulerLabels', () => ({
    isReady: ref(labelsReady), loadError: ref('Unable to load labels'), isLoading: ref(false), retryLabels: vi.fn(),
  }))
  vi.stubGlobal('useFreshAccount', () => ({ refresh: vi.fn() }))
  vi.stubGlobal('useSdkRewards', () => ({ rewards: ref([]), isRewardsLoading: ref(false) }))
  vi.stubGlobal('useREULLocks', () => ({ locks: ref([{ id: 'lock-1' }]), isLocksLoading: ref(false), refreshLocks: vi.fn() }))
  vi.stubGlobal('useEffectiveAddress', () => ({
    isConnected: ref(true), address: ref(undefined), spyAddress: ref(undefined),
    effectiveAddress: ref(undefined), isSpyMode: ref(false),
  }))
  vi.stubGlobal('useWagmi', () => ({ isConnected: ref(true) }))
  vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false) }))
  vi.stubGlobal('useWallets', () => ({ isLoaded: ref(true), updateBalances: vi.fn() }))
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1), eulerLensAddresses: ref({}) }))
  vi.stubGlobal('usePortfolioRefresh', () => ({ portfolioRefreshCounter: ref(0) }))
  vi.stubGlobal('useShowAllLabelEntries', () => ref(false))
  vi.stubGlobal('useExternalMigrationPositions', () => ({
    positions: ref([]), isLoading: ref(false), error: ref(null), unavailableSources: ref(['aave']), hasLoaded: ref(true),
  }))
  vi.stubGlobal('useActivityAvailability', () => ({ shouldRender: ref(true), isChecking: ref(false), reason: ref(null) }))
  vi.stubGlobal('usePortfolioActivityRuntimeSupport', () => ({ isRuntimeUnsupported: ref(false) }))
  vi.stubGlobal('shouldShowPortfolioActivityTab', shouldShowPortfolioActivityTab)
  vi.stubGlobal('shouldLeavePortfolioActivityRoute', shouldLeavePortfolioActivityRoute)
  vi.stubGlobal('useVaults', () => ({ isReady: ref(true) }))
  vi.stubGlobal('useVaultRegistry', () => ({ isEarnVault: () => false }))
  vi.stubGlobal('usePortfolioBatchScrollTarget', vi.fn())
  vi.stubGlobal('useDeployConfig', () => ({ enableMerkl: false, enableIncentra: false, enableFuul: false, enableTurtle: false }))
  vi.stubGlobal('useVisibleTicker', useVisibleTicker)
  vi.stubGlobal('onActivated', onActivated)
  vi.stubGlobal('onDeactivated', onDeactivated)

  const app = createSSRApp(PortfolioPage)
  const stub = defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) })
  for (const name of [
    'PortfolioShowAllHint', 'PortfolioRampingBanner', 'UiHoverPreviewTooltip', 'UiSwitch',
    'BaseLoadableContent', 'UiEmptyStateIcon', 'UiButton', 'UiLoader', 'PortfolioList',
  ]) app.component(name, stub)
  app.component('LabelsUnavailableState', LabelsUnavailableState)
  app.component('UiEmptyState', UiEmptyState)
  app.component('NuxtPage', defineComponent({ setup: () => () => h(child) }))
  app.component('UiTabs', defineComponent({
    props: { list: { type: Array as PropType<{ label: string }[]>, required: true } },
    setup: props => () => h('nav', props.list.map(tab => h('button', tab.label))),
  }))
  app.component('RewardUnlockList', defineComponent({
    props: { items: { type: Array, required: true } },
    setup: props => () => h('div', { 'data-lock-count': props.items.length }),
  }))
  app.component('PortfolioEmptyState', defineComponent({
    props: ['activeText'],
    setup: props => () => h('div', props.activeText),
  }))
  return renderToString(app)
}

afterEach(() => vi.unstubAllGlobals())

describe('Portfolio during a labels outage', () => {
  it('keeps tabs and independently loaded rEUL locks available without showing unreliable totals', async () => {
    const html = await renderPortfolio(RewardsPage, 'portfolio-rewards')
    for (const tab of ['Positions', 'Deposits', 'Rewards', 'Activity', 'Migrate']) {
      expect(html).toContain(`<button>${tab}</button>`)
    }
    expect(html).toContain('Rewards in EUL (rEUL)')
    expect(html).toContain('data-lock-count="1"')
    expect(html).not.toContain('Portfolio unavailable')
    expect(html).not.toContain('Portfolio value')
  })

  it.each([
    ['Positions', PositionsPage, 'portfolio', 'positions'],
    ['Deposits', DepositsPage, 'portfolio-saving', 'deposit positions'],
  ] as const)('shows a retry state only inside %s when labels are unavailable', async (title, page, route, emptyText) => {
    const html = await renderPortfolio(page, route)
    expect(html).toContain(`<button>${title}</button>`)
    expect(html).toContain(`${title} unavailable`)
    expect(html).toContain('Try again')
    expect(html).not.toContain(`You don&#39;t have ${emptyText} yet`)
  })

  it.each([
    ['Positions', PositionsPage, 'portfolio', 'positions'],
    ['Deposits', DepositsPage, 'portfolio-saving', 'deposit positions'],
  ] as const)('retains usable %s data when only a label refresh fails', async (title, page, route, emptyText) => {
    const html = await renderPortfolio(page, route, true)
    expect(html).toContain('Portfolio value')
    expect(html).toContain(`You don&#39;t have ${emptyText} yet`)
    expect(html).not.toContain(`${title} unavailable`)
  })
})
