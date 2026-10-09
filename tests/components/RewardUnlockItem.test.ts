import { createSSRApp, defineComponent, h, ref } from 'vue'
import { renderToString } from '@vue/server-renderer'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import RewardUnlockItem from '~/components/entities/reward/RewardUnlockItem.vue'
import type { REULLock, REULLockSnapshot } from '~/entities/reul'

const toastError = vi.fn()
vi.mock('~/components/ui/composables/useToast', () => ({ useToast: () => ({ error: toastError }) }))
vi.mock('~/utils/tx-errors', () => ({ getTxErrorMessage: vi.fn(async () => 'error') }))

const DAY = 86_400n
const LOCK_DAY = 1_780_000_000n - (1_780_000_000n % DAY)
const REUL = '0x0000000000000000000000000000000000000001'

const lock = (timestamp: bigint, amountToBeBurned = 80n): REULLock => ({
  timestamp,
  amount: 100n,
  unlockableAmount: 100n - amountToBeBurned,
  amountToBeBurned,
})

const browserNow = ref(new Date(0))
const readLockSnapshot = vi.fn<(timestamp: bigint) => Promise<REULLockSnapshot | null>>()
const buildUnlockREULPlan = vi.fn(async (_timestamps: bigint[], _quoteBlockTimestamp: bigint | undefined) => [])
const createIntent = vi.fn((args: unknown) => args)
const openReview = vi.fn(async () => {})
const captureReviewState = vi.fn(() => ({ open: openReview }))
const runSimulation = vi.fn(async () => true)

let clickUnlock: (() => Promise<void>) | undefined

const render = (item: REULLock, browserTimestamp: bigint) => {
  browserNow.value = new Date(Number(browserTimestamp) * 1000)
  const app = createSSRApp({ render: () => h(RewardUnlockItem, { item }) })
  app.component('UiButton', defineComponent({
    inheritAttrs: false,
    setup: (_, { attrs, slots }) => {
      clickUnlock = attrs.onClick as () => Promise<void>
      return () => h('button', { disabled: attrs.disabled || undefined }, slots.default?.())
    },
  }))
  app.component('AssetAvatar', { render: () => h('span') })
  return renderToString(app)
}

describe('RewardUnlockItem early-unlock gate', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    clickUnlock = undefined
    vi.stubGlobal('useSpyMode', () => ({ isSpyMode: ref(false) }))
    vi.stubGlobal('useTokenList', () => ({ getTokenByAddress: () => ({ symbol: 'rEUL', decimals: 18 }) }))
    vi.stubGlobal('useREULLocks', () => ({
      buildUnlockREULPlan,
      readLockSnapshot,
      refreshLocks: vi.fn(async () => []),
      reulTokenContractAddress: ref(REUL),
      eulTokenContractAddress: ref(''),
    }))
    vi.stubGlobal('useTxBatch', () => ({ entryCount: ref(0), clearBatch: vi.fn() }))
    vi.stubGlobal('useOperationIntentFactory', () => ({ create: createIntent }))
    vi.stubGlobal('useExecutionReview', () => ({ capture: captureReviewState }))
    vi.stubGlobal('useEulerAddresses', () => ({ chainId: ref(1) }))
    vi.stubGlobal('useWagmi', () => ({ chainId: ref(1), switchChain: vi.fn() }))
    vi.stubGlobal('useTransactionPlanSimulation', () => ({ runSimulation, simulationError: ref('') }))
    vi.stubGlobal('useNow', () => browserNow)
    vi.stubGlobal('useIntervalFn', vi.fn())
  })
  afterEach(() => vi.unstubAllGlobals())

  it('disables today\'s lock and names the UTC time it opens', async () => {
    const html = await render(lock(LOCK_DAY), LOCK_DAY + 3_600n)
    expect(html).toMatch(/<button disabled/)
    expect(html).toContain('data-testid="reul-unlock-open-lock"')
    expect(html).toContain(' 00:00 UTC')
  })

  it('enables an earlier day\'s lock and a fully vested lock from today', async () => {
    for (const [item, browserTimestamp] of [[lock(LOCK_DAY), LOCK_DAY + DAY], [lock(LOCK_DAY, 0n), LOCK_DAY + 1n]] as const) {
      const html = await render(item, browserTimestamp)
      expect(html).not.toMatch(/<button disabled/)
      expect(html).not.toContain('reul-unlock-open-lock')
    }
  })

  it('does not start a review when chain time still places the lock in today', async () => {
    readLockSnapshot.mockResolvedValue({ blockNumber: 1n, blockTimestamp: LOCK_DAY + DAY - 1n, lock: lock(LOCK_DAY) })
    await render(lock(LOCK_DAY), LOCK_DAY + DAY + 60n)
    await clickUnlock!()

    expect(toastError).toHaveBeenCalledWith('Early unlock for this rEUL lock opens at 00:00 UTC')
    expect(createIntent).not.toHaveBeenCalled()
    expect(captureReviewState).not.toHaveBeenCalled()
    expect(buildUnlockREULPlan).not.toHaveBeenCalled()
    expect(openReview).not.toHaveBeenCalled()
  })

  it('binds the snapshot block timestamp to the intent and the plan for an earlier day\'s lock', async () => {
    const quoteBlockTimestamp = LOCK_DAY + DAY
    readLockSnapshot.mockResolvedValue({ blockNumber: 1n, blockTimestamp: quoteBlockTimestamp, lock: lock(LOCK_DAY) })
    await render(lock(LOCK_DAY), LOCK_DAY + 2n * DAY)
    await clickUnlock!()

    expect(readLockSnapshot).toHaveBeenCalledWith(LOCK_DAY)
    expect(createIntent).toHaveBeenCalledWith(expect.objectContaining({
      args: expect.objectContaining({ quoteBlockTimestamp: Number(quoteBlockTimestamp), remainderLossMaximum: 80n }),
    }))
    expect(buildUnlockREULPlan).toHaveBeenCalledWith([LOCK_DAY], quoteBlockTimestamp)
    expect(openReview).toHaveBeenCalledOnce()
    expect(toastError).not.toHaveBeenCalled()
  })

  it('does not start a review when the lock grew after it was displayed', async () => {
    readLockSnapshot.mockResolvedValue({ blockNumber: 1n, blockTimestamp: LOCK_DAY + DAY, lock: { ...lock(LOCK_DAY), amount: 200n } })
    await render(lock(LOCK_DAY), LOCK_DAY + DAY)
    await clickUnlock!()

    expect(createIntent).not.toHaveBeenCalled()
    expect(openReview).not.toHaveBeenCalled()
  })
})
