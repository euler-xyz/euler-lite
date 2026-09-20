import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import PortfolioSdkRewardItem from '~/components/entities/portfolio/PortfolioSdkRewardItem.vue'
import type { UserReward } from '~/entities/reward-campaign'

vi.mock('~/components/ui/composables/useToast', () => ({ useToast: () => ({ error: vi.fn() }) }))

const usdcAddress = '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48'

// The production Turtle row: 603375 raw units, worth $0.60 at 6 decimals and
// nothing recognisable at all when the token never resolved.
const makeReward = (decimals: number | undefined): UserReward => ({
  provider: 'turtle',
  chainId: 1,
  token: {
    address: usdcAddress,
    chainId: 1,
    symbol: decimals === undefined ? usdcAddress : 'USDC',
    name: decimals === undefined ? usdcAddress : 'USD Coin',
    decimals,
  },
  tokenPrice: 1,
  accumulated: '603375',
  unclaimed: '603375',
  campaignId: '4242c3ea-b6cc-46d5-8592-d072620b51bc',
} as unknown as UserReward)

const renderItem = (reward: UserReward) => {
  const app = createSSRApp({ render: () => h(PortfolioSdkRewardItem, { reward }) })
  app.component('UiButton', defineComponent({
    inheritAttrs: false,
    setup: (_, { attrs, slots }) => () => h('button', attrs, slots.default?.()),
  }))
  for (const name of ['AssetAvatar', 'SvgIcon']) {
    app.component(name, { render: () => h('span') })
  }
  return renderToString(app)
}

describe('portfolio reward item with unresolved token decimals', () => {
  beforeEach(() => {
    vi.stubGlobal('useSdkRewards', () => ({ buildClaimRewardPlan: vi.fn(), refreshRewards: vi.fn() }))
    vi.stubGlobal('useREULLocks', () => ({ refreshLocks: vi.fn() }))
    vi.stubGlobal('useTxBatch', () => ({
      addEntry: vi.fn(), entries: ref([]), entryCount: ref(0), clearBatch: vi.fn(),
    }))
    vi.stubGlobal('useOperationIntentFactory', () => ({ create: vi.fn() }))
    vi.stubGlobal('useExecutionReview', () => ({ capture: vi.fn() }))
    vi.stubGlobal('useTokenList', () => ({ getTokenByAddress: () => undefined }))
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false) }))
    vi.stubGlobal('useUserSettings', () => ({ settings: ref({ enableAdvancedMode: false }) }))
    vi.stubGlobal('useEulerAddresses', () => ({ eulerTokenAddresses: ref({ rEUL: undefined }) }))
    vi.stubGlobal('useWagmi', () => ({ chainId: ref(1), switchChain: vi.fn() }))
    vi.stubGlobal('useTransactionPlanSimulation', () => ({
      runSimulation: vi.fn(), simulationError: ref(null),
    }))
  })
  afterEach(() => vi.unstubAllGlobals())

  it('states the amount is unavailable instead of scaling it by a guess', async () => {
    const html = await renderItem(makeReward(undefined))

    expect(html).toContain('Amount unavailable')
    expect(html).toContain('This reward token could not be identified')
    // No scaled amount, and no USD value derived from one.
    expect(html).not.toContain('0.60')
    expect(html).not.toContain('&lt; 0.01')
    expect(html).toContain('—')
  })

  it('offers no claim path for a reward whose amount it cannot state', async () => {
    const html = await renderItem(makeReward(undefined))

    expect(html).toMatch(/<button[^>]*disabled/)
  })

  it('shows the scaled amount and an enabled claim once decimals resolve', async () => {
    const html = await renderItem(makeReward(6))

    expect(html).toContain('0.60 USDC')
    expect(html).toContain('$0.60')
    expect(html).not.toContain('Amount unavailable')
    expect(html).not.toContain('This reward token could not be identified')
    expect(html).not.toMatch(/<button[^>]*disabled/)
  })
})
