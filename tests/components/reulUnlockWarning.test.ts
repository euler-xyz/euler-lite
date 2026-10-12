import { createSSRApp, defineComponent, h, onMounted, onUnmounted, ref, type Component } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { DateTime } from 'luxon'
import RewardUnlockItem from '~/components/entities/reward/RewardUnlockItem.vue'
import OperationReviewModal from '~/components/entities/operation/OperationReviewModal.vue'
import type { REULLock } from '~/entities/reul'

vi.mock('~/components/ui/composables/useToast', () => ({ useToast: () => ({ error: vi.fn() }) }))
vi.mock('~/composables/useVaultRegistry', () => ({ useVaultRegistry: () => ({ getVault: vi.fn() }) }))
vi.mock('~/composables/useEulerSdk', () => ({ getEulerSdkForChain: vi.fn() }))
vi.mock('~/composables/useEulerLabels', () => ({ getCurrentEulerLabelsData: () => undefined }))
vi.mock('~/composables/useTokenList', () => ({ getAssetLogoUrl: () => '' }))
vi.mock('~/composables/useStateOverrideOptions', () => ({
  useStateOverrideResolution: () => ({ isResolvingStateOverrideHints: ref(false) }),
}))

const tokenAddress = '0x1000000000000000000000000000000000000000'
const capture = vi.fn((_intents: unknown, _options: unknown) => ({ open: vi.fn() }))
const refreshLocks = vi.fn()

const renderComponent = (component: Component, props: Record<string, unknown>) => {
  let unlock: (() => Promise<void>) | undefined
  const app = createSSRApp({ render: () => h(component, props) })
  app.component('BaseModalWrapper', defineComponent({
    setup: (_, { slots }) => () => h('div', slots.default?.()),
  }))
  app.component('UiButton', defineComponent({
    inheritAttrs: false,
    setup: (_, { attrs, slots }) => {
      if (typeof attrs.onClick === 'function') unlock = attrs.onClick as () => Promise<void>
      return () => h('button', attrs, slots.default?.())
    },
  }))
  app.component('UiAlert', defineComponent({
    props: ['title', 'description'],
    setup: props => () => h('p', { 'data-alert-title': props.title }, props.description),
  }))
  for (const name of ['AssetAvatar', 'SvgIcon', 'BatchMarketLabel', 'OperationStepsList']) {
    app.component(name, { render: () => h('span') })
  }
  return renderToString(app).then(html => ({ html, unlock }))
}

beforeEach(() => {
  vi.useFakeTimers()
  vi.setSystemTime(new Date('2026-10-12T12:00:00Z'))
  capture.mockClear()
  refreshLocks.mockReset()
  vi.stubGlobal('onMounted', onMounted)
  vi.stubGlobal('onUnmounted', onUnmounted)
  vi.stubGlobal('useNow', () => ref(new Date()))
  vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false) }))
  vi.stubGlobal('useEffectiveAddress', () => ({
    address: ref(tokenAddress), effectiveAddress: ref(tokenAddress), isSpyMode: ref(false),
  }))
  vi.stubGlobal('useTokenList', () => ({ getTokenByAddress: () => ({ symbol: 'EUL', decimals: 18 }) }))
  vi.stubGlobal('useREULLocks', () => ({
    buildUnlockREULPlan: vi.fn(async () => []),
    reulTokenContractAddress: ref(tokenAddress), eulTokenContractAddress: ref(tokenAddress),
    refreshLocks,
    getLatestBlockTimestamp: async () => BigInt(Math.floor(Date.now() / 1000)),
  }))
  vi.stubGlobal('useTxBatch', () => ({ entryCount: ref(0), clearBatch: vi.fn() }))
  vi.stubGlobal('useOperationIntentFactory', () => ({ create: (input: unknown) => input }))
  vi.stubGlobal('useExecutionReview', () => ({ capture }))
  vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1), eulerCoreAddresses: ref({}) }))
  vi.stubGlobal('useWagmi', () => ({ chainId: ref(1), switchChain: vi.fn() }))
  vi.stubGlobal('useTransactionPlanSimulation', () => ({ runSimulation: async () => true, simulationError: ref(null) }))
  vi.stubGlobal('useSafeWallet', () => ({ isSafeWallet: ref(false) }))
  vi.stubGlobal('useSafeExecutionDetachment', () => ({ hasPendingDetachedExecution: ref(false) }))
  vi.stubGlobal('useClipboardCopy', () => ({ copied: ref(false), copyToClipboard: vi.fn() }))
  vi.stubGlobal('useTenderlySimulation', () => ({
    isSimulating: ref(false), simulationError: ref(''), simulationUrl: ref(''),
    simulate: vi.fn(), clearSimulation: vi.fn(), fetchEnabled: async () => false,
  }))
})
afterEach(() => {
  vi.clearAllTimers()
  vi.useRealTimers()
  vi.unstubAllGlobals()
})

describe('rEUL unlock burn warning', () => {
  it.each([
    { label: 'matured lock with zero burn', burn: 0n, remainingHours: -24, warning: false },
    { label: 'partially vested lock', burn: 20n * 10n ** 18n, remainingHours: 48, warning: true },
    { label: 'positive burn with zero displayed days', burn: 10n ** 18n, remainingHours: 12, warning: true },
    { label: 'one raw unit that formats as zero', burn: 1n, remainingHours: 12, warning: true },
    { label: 'zero burn while the browser countdown is positive', burn: 0n, remainingHours: 48, warning: false },
  ])('$label', async ({ burn, remainingHours, warning }) => {
    const timestamp = BigInt(Math.floor(DateTime.now().minus({ days: 180 }).plus({ hours: remainingHours }).toSeconds()))
    const lock: REULLock = {
      timestamp, amount: 100n * 10n ** 18n,
      unlockableAmount: 100n * 10n ** 18n - burn, amountToBeBurned: burn,
    }
    refreshLocks.mockResolvedValue([lock])
    const { unlock } = await renderComponent(RewardUnlockItem, { item: lock })
    expect(unlock).toBeDefined()
    await unlock!()

    expect(capture).toHaveBeenCalledOnce()
    const options = capture.mock.calls[0][1] as {
      review: { reulUnlockInfo: { hasBurn: boolean, daysUntilMaturity: number } }
    }
    expect(options.review.reulUnlockInfo.hasBurn).toBe(warning)
    if (remainingHours === 12) expect(options.review.reulUnlockInfo.daysUntilMaturity).toBe(0)

    const { html } = await renderComponent(OperationReviewModal, {
      ...options.review,
      prepared: { plan: [{ type: 'evcBatch', items: [] }] },
    })
    expect(html.includes('data-alert-title="Important"')).toBe(warning)
    expect(html).toContain('data-operation-type="reul-unlock"')
    if (burn === 1n) expect(html).toContain('0.00 EUL will be permanently burned')
  })

  it('uses the refreshed quote when the lock matures before review opens', async () => {
    const lock: REULLock = {
      timestamp: BigInt(Math.floor(Date.now() / 1000)) - 180n * 86_400n,
      amount: 100n, unlockableAmount: 99n, amountToBeBurned: 1n,
    }
    refreshLocks.mockResolvedValue([{ ...lock, unlockableAmount: 100n, amountToBeBurned: 0n }])
    const { unlock } = await renderComponent(RewardUnlockItem, { item: lock })
    await unlock!()

    const options = capture.mock.calls[0][1] as { review: { reulUnlockInfo: { hasBurn: boolean } } }
    expect(options.review.reulUnlockInfo.hasBurn).toBe(false)
    const { html } = await renderComponent(OperationReviewModal, { ...options.review, hideExecute: true })
    expect(html).not.toContain('data-alert-title="Important"')
  })
})
