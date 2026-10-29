import { effectScope, nextTick, ref, type EffectScope } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const OWNER = '0x1000000000000000000000000000000000000000'
const OTHER = '0x5000000000000000000000000000000000000000'
const scopes: EffectScope[] = []
const newScope = () => {
  const scope = effectScope()
  scopes.push(scope)
  return scope
}
const deferred = <T>() => {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((done) => {
    resolve = done
  })
  return { promise, resolve }
}
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve()
  await nextTick()
}

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
  vi.stubGlobal('window', new EventTarget())
})
afterEach(() => {
  scopes.splice(0).forEach(scope => scope.stop())
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.doUnmock('~/composables/useVaults')
  vi.doUnmock('~/composables/useWallets')
  vi.doUnmock('~/utils/portfolioPositionFilter')
  vi.doUnmock('~/composables/useTxBatch')
})

describe('position polling with account refresh cancellation', () => {
  it.each(['reset', 'preempt'] as const)('resumes polling after %s cancels a running queued refresh', async (cancellation) => {
    const ready = ref(false)
    const effectiveAddress = ref(OWNER)
    const fetchAccount = vi.fn(async (_chain: number, owner: string) => ({ result: { owner }, errors: [] }))
    const sdk = {
      accountService: { fetchAccount },
      portfolioService: { buildPortfolio: (account: { owner: string }) => ({ account, borrows: [], savings: [] }) },
    }
    vi.doMock('~/composables/useVaults', () => ({ useVaults: () => ({ isReady: ready }) }))
    vi.doMock('~/composables/useWallets', () => ({ useWallets: () => ({ isLoaded: ready }) }))
    vi.doMock('~/utils/portfolioPositionFilter', () => ({ hydrateHeldVaults: async () => {}, buildVisiblePortfolioPositionFilter: () => () => true }))
    vi.doMock('~/composables/useTxBatch', () => ({
      activeLayerPortfolioRef: ref(), activeLayerPortfolioAllRef: ref(),
      activeLayerRemovedBorrowPositionsRef: ref([]), activeLayerRemovedBorrowPositionsAllRef: ref([]),
      activeLayerRemovedDepositPositionsRef: ref([]), activeLayerRemovedDepositPositionsAllRef: ref([]), activeLayerRemovedKeysRef: ref(new Set()),
    }))
    vi.stubGlobal('useEulerLabels', () => ({ isReady: ready }))
    vi.stubGlobal('useEulerAddresses', () => ({ isReady: ready, chainId: ref(1) }))
    vi.stubGlobal('useEffectiveAddress', () => ({ effectiveAddress }))
    vi.stubGlobal('useEulerSdk', () => ({ getEulerSdkFresh: async () => sdk }))
    const { useEulerAccount } = await import('~/composables/useEulerAccount')
    const account = newScope().run(useEulerAccount)!
    await account.refreshAllPositions()
    const first = deferred<Awaited<ReturnType<typeof fetchAccount>>>()
    const rerun = deferred<Awaited<ReturnType<typeof fetchAccount>>>()
    fetchAccount.mockReturnValueOnce(first.promise).mockReturnValueOnce(rerun.promise)
    const existing = account.refreshAllPositions()
    await flush()

    const refreshFreshAccount = vi.fn()
    const reread = vi.fn(async () => {})
    vi.stubGlobal('useEulerAccount', () => account)
    vi.stubGlobal('useFreshAccount', () => ({ refresh: refreshFreshAccount }))
    vi.stubGlobal('useTxBatch', () => ({ entryCount: ref(0), isSimulating: ref(false) }))
    const { usePositionAutoRefresh } = await import('~/composables/position/usePositionAutoRefresh')
    const ticker = newScope().run(() => usePositionAutoRefresh({ isBusy: () => account.isPositionsLoading.value, reread }))!
    ticker.start()
    await vi.advanceTimersByTimeAsync(60_000)
    first.resolve({ result: { owner: OWNER }, errors: [] })
    await flush()
    expect(fetchAccount).toHaveBeenCalledTimes(3)
    if (cancellation === 'reset') {
      effectiveAddress.value = OTHER
      await nextTick()
      await account.refreshAllPositions()
    }
    else {
      await account.refreshAllPositions(undefined, OWNER, { preempt: true })
    }
    expect(fetchAccount).toHaveBeenCalledTimes(4)
    expect(account.isPositionsLoading.value).toBe(false)
    reread.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refreshFreshAccount).toHaveBeenCalledTimes(2)
    expect(fetchAccount).toHaveBeenCalledTimes(5)
    expect(fetchAccount.mock.lastCall?.[1]).toBe(cancellation === 'reset' ? OTHER : OWNER)
    expect(reread).toHaveBeenCalledTimes(1)

    rerun.resolve({ result: { owner: OWNER }, errors: [] })
    await existing
    await flush()
    expect(account.portfolio.value?.account.owner).toBe(cancellation === 'reset' ? OTHER : OWNER)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchAccount).toHaveBeenCalledTimes(6)
    expect(fetchAccount.mock.lastCall?.[1]).toBe(cancellation === 'reset' ? OTHER : OWNER)
  })
})
