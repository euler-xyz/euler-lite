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
  let reject!: (error: Error) => void
  const promise = new Promise<T>((done, fail) => {
    resolve = done
    reject = fail
  })
  return { promise, resolve, reject }
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
  const chainId = ref(1)
  const fetchAccount = vi.fn(async (_chain: number, owner: string) => response(0, owner))
  const sdk = {
    accountService: { fetchAccount },
    portfolioService: { buildPortfolio: (account: { owner: string, revision: number }) => ({ account, borrows: [], savings: [] }) },
  }
  const getEulerSdkFresh = vi.fn(async () => sdk)
  const hydrateHeldVaults = vi.fn(async () => {})
  vi.doMock('~/composables/useVaults', () => ({ useVaults: () => ({ isReady: ready }) }))
  vi.doMock('~/composables/useWallets', () => ({ useWallets: () => ({ isLoaded: ready }) }))
  vi.doMock('~/utils/portfolioPositionFilter', () => ({ hydrateHeldVaults, buildVisiblePortfolioPositionFilter: () => () => true }))
  vi.doMock('~/composables/useTxBatch', () => ({
    activeLayerPortfolioRef: ref(), activeLayerPortfolioAllRef: ref(),
    activeLayerRemovedBorrowPositionsRef: ref([]), activeLayerRemovedBorrowPositionsAllRef: ref([]),
    activeLayerRemovedDepositPositionsRef: ref([]), activeLayerRemovedDepositPositionsAllRef: ref([]), activeLayerRemovedKeysRef: ref(new Set()),
  }))
  vi.stubGlobal('useEulerLabels', () => ({ isReady: ready }))
  vi.stubGlobal('useEulerAddresses', () => ({ isReady: ready, chainId }))
  vi.stubGlobal('useEffectiveAddress', () => ({ effectiveAddress }))
  vi.stubGlobal('useEulerSdk', () => ({ getEulerSdkFresh }))
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
  return { account, effectiveAddress, chainId, sdk, getEulerSdkFresh, hydrateHeldVaults, fetchAccount, refreshFreshAccount, displayed, reread, ticker }
}

describe('position polling with account refresh cancellation', () => {
  it.each(
    (['sdk', 'account', 'hydration'] as const).flatMap(stage =>
      (['owner reset', 'chain reset', 'preempt'] as const).map(cancellation => ({ stage, cancellation })),
    ),
  )('resumes polling when $cancellation cancels the initial $stage read', async ({ stage, cancellation }) => {
    const { account, effectiveAddress, chainId, sdk, getEulerSdkFresh, hydrateHeldVaults, fetchAccount, refreshFreshAccount, displayed, reread, ticker } = await setup()
    const pendingSdk = deferred<typeof sdk>()
    const pendingAccount = deferred<ReturnType<typeof response>>()
    const pendingHydration = deferred<undefined>()
    if (stage === 'sdk') getEulerSdkFresh.mockReturnValueOnce(pendingSdk.promise)
    if (stage === 'account') fetchAccount.mockReturnValueOnce(pendingAccount.promise)
    if (stage === 'hydration') hydrateHeldVaults.mockReturnValueOnce(pendingHydration.promise)
    ticker.start()
    await vi.advanceTimersByTimeAsync(60_000)

    const currentOwner = cancellation === 'owner reset' ? OTHER : OWNER
    const currentChainId = cancellation === 'chain reset' ? 10 : 1
    fetchAccount.mockResolvedValue(response(3, currentOwner))
    if (cancellation === 'preempt') {
      await account.refreshAllPositions(undefined, OWNER, { preempt: true })
    }
    else {
      effectiveAddress.value = currentOwner
      chainId.value = currentChainId
      await nextTick()
      await account.refreshAllPositions()
    }
    await flush()
    expect(account.isPositionsLoading.value).toBe(false)
    const callsAfterReplacement = fetchAccount.mock.calls.length
    reread.mockClear()
    await vi.advanceTimersByTimeAsync(60_000)
    expect.soft(refreshFreshAccount).toHaveBeenCalledTimes(2)
    expect.soft(fetchAccount).toHaveBeenCalledTimes(callsAfterReplacement + 1)
    expect.soft(reread).toHaveBeenCalledTimes(1)
    expect.soft(displayed.value).toBe(3)
    expect(fetchAccount.mock.lastCall?.slice(0, 2)).toEqual([currentChainId, currentOwner])

    const callsBeforeStaleCompletion = fetchAccount.mock.calls.length
    pendingSdk.resolve(sdk)
    pendingAccount.resolve(response(1))
    pendingHydration.resolve(undefined)
    await flush()
    expect(fetchAccount).toHaveBeenCalledTimes(callsBeforeStaleCompletion)
    expect(account.portfolio.value?.account.owner).toBe(currentOwner)
    expect((account.portfolio.value?.account as unknown as { revision: number }).revision).toBe(3)
    expect(displayed.value).toBe(3)
  })

  it('keeps replacement waiters pending when a canceled initial read rejects late', async () => {
    const { account, fetchAccount, displayed, reread, ticker } = await setup()
    const original = deferred<ReturnType<typeof response>>()
    const replacement = deferred<ReturnType<typeof response>>()
    fetchAccount.mockReturnValueOnce(original.promise).mockReturnValueOnce(replacement.promise)
    ticker.start()
    await vi.advanceTimersByTimeAsync(60_000)
    const queued = account.refreshAllPositions()
    const replacing = account.refreshAllPositions(undefined, OWNER, { preempt: true })
    const replacementSettled = vi.fn()
    const replacementWaiting = account.refreshAllPositions().then(replacementSettled)
    await expect(queued).resolves.toBe('cancelled')
    await flush()

    original.reject(new Error('obsolete request failed'))
    await flush()
    expect(replacementSettled).not.toHaveBeenCalled()
    expect(reread).not.toHaveBeenCalled()
    expect(account.portfolioDiagnostics.value).toEqual([])

    fetchAccount.mockResolvedValue(response(3))
    replacement.resolve(response(3))
    await Promise.all([replacing, replacementWaiting])
    await flush()
    expect(replacementSettled).toHaveBeenCalledWith('completed')
    expect(reread).toHaveBeenCalledTimes(1)
    expect(displayed.value).toBe(3)
  })

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
