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
const response = (revision: number, owner = OWNER) => ({ result: { owner, revision }, errors: [] })

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

const setup = async () => {
  const ready = ref(false)
  const effectiveAddress = ref(OWNER)
  const fetchAccount = vi.fn(async (_chain: number, owner: string) => response(0, owner))
  const sdk = {
    accountService: { fetchAccount },
    portfolioService: { buildPortfolio: (account: { owner: string, revision: number }) => ({ account, borrows: [], savings: [] }) },
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
  const refreshFreshAccount = vi.fn()
  const displayed = ref(0)
  const reread = vi.fn(async () => {
    displayed.value = (account.portfolio.value?.account as unknown as { revision: number }).revision
  })
  vi.stubGlobal('useEulerAccount', () => account)
  vi.stubGlobal('useFreshAccount', () => ({ refresh: refreshFreshAccount }))
  vi.stubGlobal('useTxBatch', () => ({ entryCount: ref(0), isSimulating: ref(false) }))
  const { usePositionAutoRefresh } = await import('~/composables/position/usePositionAutoRefresh')
  const ticker = newScope().run(() => usePositionAutoRefresh({ isBusy: () => account.isPositionsLoading.value, reread }))!
  return { account, effectiveAddress, fetchAccount, refreshFreshAccount, displayed, reread, ticker }
}

describe('position polling with account refresh cancellation', () => {
  it.each([
    { caller: 'queued', cancellation: 'reset' },
    { caller: 'queued', cancellation: 'preempt' },
    { caller: 'original', cancellation: 'reset' },
    { caller: 'original', cancellation: 'preempt' },
  ])('resumes the $caller poll after $cancellation cancels a running rerun', async ({ caller, cancellation }) => {
    const { account, effectiveAddress, fetchAccount, refreshFreshAccount, reread, ticker } = await setup()
    const original = deferred<ReturnType<typeof response>>()
    const rerun = deferred<ReturnType<typeof response>>()
    fetchAccount.mockReturnValueOnce(original.promise).mockReturnValueOnce(rerun.promise)
    let otherCaller: Promise<unknown>
    if (caller === 'queued') {
      otherCaller = account.refreshAllPositions()
      await flush()
    }
    ticker.start()
    await vi.advanceTimersByTimeAsync(60_000)
    if (caller === 'original') otherCaller = account.refreshAllPositions()
    original.resolve(response(1))
    await flush()
    expect(fetchAccount).toHaveBeenCalledTimes(3)

    const currentOwner = cancellation === 'reset' ? OTHER : OWNER
    if (cancellation === 'reset') {
      effectiveAddress.value = currentOwner
      await nextTick()
      await account.refreshAllPositions()
    }
    else {
      await account.refreshAllPositions(undefined, OWNER, { preempt: true })
    }
    await otherCaller!
    await flush()
    expect(account.isPositionsLoading.value).toBe(false)
    const callsAfterReplacement = fetchAccount.mock.calls.length
    reread.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect(refreshFreshAccount).toHaveBeenCalledTimes(2)
    expect(fetchAccount).toHaveBeenCalledTimes(callsAfterReplacement + 1)
    expect(fetchAccount.mock.lastCall?.[1]).toBe(currentOwner)
    expect(reread).toHaveBeenCalledTimes(1)

    rerun.resolve(response(2))
    await flush()
    expect(account.portfolio.value?.account.owner).toBe(currentOwner)
    expect((account.portfolio.value?.account as unknown as { revision: number }).revision).toBe(0)
    await vi.advanceTimersByTimeAsync(60_000)
    expect(fetchAccount).toHaveBeenCalledTimes(callsAfterReplacement + 2)
    expect(fetchAccount.mock.lastCall?.[1]).toBe(currentOwner)
  })

  it('rereads the replacement snapshot after a queued poll is preempted', async () => {
    const { account, fetchAccount, displayed, reread, ticker } = await setup()
    const original = deferred<ReturnType<typeof response>>()
    const rerun = deferred<ReturnType<typeof response>>()
    const replacement = deferred<ReturnType<typeof response>>()
    fetchAccount.mockReturnValueOnce(original.promise).mockReturnValueOnce(rerun.promise).mockReturnValueOnce(replacement.promise)
    const existing = account.refreshAllPositions()
    await flush()
    ticker.start()
    await vi.advanceTimersByTimeAsync(60_000)
    original.resolve(response(1))
    await flush()
    expect(fetchAccount).toHaveBeenCalledTimes(3)

    const preempting = account.refreshAllPositions(undefined, OWNER, { preempt: true })
    await flush()
    expect(reread).not.toHaveBeenCalled()
    fetchAccount.mockResolvedValue(response(3))
    replacement.resolve(response(3))
    await preempting
    await flush()
    expect(reread).toHaveBeenCalledTimes(1)
    expect(displayed.value).toBe(3)
    rerun.resolve(response(2))
    await existing
    await flush()
    expect(displayed.value).toBe(3)
  })
})
