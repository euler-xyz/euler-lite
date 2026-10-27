import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const INTERVAL = 60_000

const deferred = () => {
  let resolve!: () => void
  const promise = new Promise<void>((resolvePromise) => {
    resolve = resolvePromise
  })
  return { promise, resolve }
}

const mocks = {
  entryCount: ref(0),
  isSimulating: ref(false),
  refreshAllPositions: vi.fn(),
  refreshFreshAccount: vi.fn(),
}

describe('usePositionAutoRefresh', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    mocks.entryCount.value = 0
    mocks.isSimulating.value = false
    mocks.refreshAllPositions.mockReset()
    mocks.refreshFreshAccount.mockReset()
    vi.stubGlobal('document', Object.assign(new EventTarget(), { visibilityState: 'visible' }))
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('useEulerAccount', () => ({ refreshAllPositions: mocks.refreshAllPositions }))
    vi.stubGlobal('useFreshAccount', () => ({ refresh: mocks.refreshFreshAccount }))
    vi.stubGlobal('useTxBatch', () => ({ entryCount: mocks.entryCount, isSimulating: mocks.isSimulating }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const startRefresh = async (options: { isBusy?: () => boolean, reread?: () => Promise<void> } = {}) => {
    const reread = vi.fn(options.reread ?? (async () => {}))
    const { usePositionAutoRefresh } = await import('~/composables/position/usePositionAutoRefresh')
    const refresh = usePositionAutoRefresh({ isBusy: options.isBusy ?? (() => false), reread })
    refresh.start()
    return { refresh, reread }
  }

  it('refreshes the portfolio and then re-reads the position on each visible tick', async () => {
    const order: string[] = []
    mocks.refreshAllPositions.mockImplementation(async () => {
      order.push('portfolio')
    })
    const { refresh, reread } = await startRefresh({
      reread: async () => {
        order.push('position')
      },
    })

    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(mocks.refreshFreshAccount).toHaveBeenCalledTimes(1)
    expect(reread).toHaveBeenCalledTimes(1)
    expect(order).toEqual(['portfolio', 'position'])
    refresh.stop()
  })

  it.each([
    ['a batch has entries', () => { mocks.entryCount.value = 1 }],
    ['a batch is being simulated', () => { mocks.isSimulating.value = true }],
  ])('skips the tick while %s', async (_case, arrange) => {
    arrange()
    const { refresh, reread } = await startRefresh()

    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(mocks.refreshAllPositions).not.toHaveBeenCalled()
    expect(reread).not.toHaveBeenCalled()
    refresh.stop()
  })

  it('skips the tick while the page is busy', async () => {
    const { refresh, reread } = await startRefresh({ isBusy: () => true })

    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(mocks.refreshAllPositions).not.toHaveBeenCalled()
    expect(reread).not.toHaveBeenCalled()
    refresh.stop()
  })

  it('does not re-read the position when a batch starts during the portfolio refresh', async () => {
    const portfolio = deferred()
    mocks.refreshAllPositions.mockReturnValue(portfolio.promise)
    const { refresh, reread } = await startRefresh()

    await vi.advanceTimersByTimeAsync(INTERVAL)
    mocks.entryCount.value = 1
    portfolio.resolve()
    await vi.advanceTimersByTimeAsync(0)

    expect(reread).not.toHaveBeenCalled()
    refresh.stop()
  })
})
