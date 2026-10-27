import { ref } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const INTERVAL = 60_000

const mocks = {
  isConnected: ref(false),
  isVaultsReady: ref(true),
  refreshVaults: vi.fn(),
  updateBalances: vi.fn(),
  refreshLabelsIfStale: vi.fn(),
  refreshLiquidationCoverageIfStale: vi.fn(),
}

describe('useAppRefresh', () => {
  let doc: EventTarget & { visibilityState: DocumentVisibilityState }

  beforeEach(() => {
    vi.useFakeTimers()
    vi.resetModules()
    Object.values(mocks).forEach(mock => typeof mock === 'function' && mock.mockReset())
    mocks.isConnected.value = false
    mocks.isVaultsReady.value = true
    doc = Object.assign(new EventTarget(), { visibilityState: 'visible' as DocumentVisibilityState })
    vi.stubGlobal('document', doc)
    vi.stubGlobal('window', new EventTarget())
    vi.stubGlobal('useVaults', () => ({ isReady: mocks.isVaultsReady, refreshVaults: mocks.refreshVaults }))
    vi.stubGlobal('useWallets', () => ({ updateBalances: mocks.updateBalances }))
    vi.stubGlobal('useWagmi', () => ({ isConnected: mocks.isConnected }))
    vi.stubGlobal('useEulerLabels', () => ({ refreshLabelsIfStale: mocks.refreshLabelsIfStale }))
    vi.stubGlobal('useLiquidationCoverage', () => ({
      refreshLiquidationCoverageIfStale: mocks.refreshLiquidationCoverageIfStale,
    }))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  const startRefresh = async () => {
    const { useAppRefresh } = await import('~/composables/useAppRefresh')
    const refresh = useAppRefresh()
    refresh.start()
    return refresh
  }

  it('refreshes vaults and balances with a wallet', async () => {
    mocks.isConnected.value = true
    const refresh = await startRefresh()
    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(mocks.refreshVaults).toHaveBeenCalledTimes(1)
    expect(mocks.updateBalances).toHaveBeenCalledTimes(1)
    expect(mocks.refreshLabelsIfStale).toHaveBeenCalledTimes(1)
    expect(mocks.refreshLiquidationCoverageIfStale).toHaveBeenCalledTimes(1)
    refresh.stop()
  })

  it('refreshes only labels and liquidation coverage without a wallet', async () => {
    const refresh = await startRefresh()
    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(mocks.refreshVaults).not.toHaveBeenCalled()
    expect(mocks.updateBalances).not.toHaveBeenCalled()
    expect(mocks.refreshLabelsIfStale).toHaveBeenCalledTimes(1)
    expect(mocks.refreshLiquidationCoverageIfStale).toHaveBeenCalledTimes(1)
    refresh.stop()
  })

  it('does not refresh vaults or balances before the vaults are loaded', async () => {
    mocks.isConnected.value = true
    mocks.isVaultsReady.value = false
    const refresh = await startRefresh()
    await vi.advanceTimersByTimeAsync(INTERVAL)

    expect(mocks.refreshVaults).not.toHaveBeenCalled()
    expect(mocks.updateBalances).not.toHaveBeenCalled()
    refresh.stop()
  })

  it('polls nothing while the tab is hidden and catches up when it is shown again', async () => {
    mocks.isConnected.value = true
    const refresh = await startRefresh()
    doc.visibilityState = 'hidden'
    doc.dispatchEvent(new Event('visibilitychange'))

    await vi.advanceTimersByTimeAsync(5 * INTERVAL)
    expect(mocks.refreshVaults).not.toHaveBeenCalled()
    expect(mocks.updateBalances).not.toHaveBeenCalled()

    doc.visibilityState = 'visible'
    doc.dispatchEvent(new Event('visibilitychange'))
    await vi.advanceTimersByTimeAsync(0)
    expect(mocks.refreshVaults).toHaveBeenCalledTimes(1)
    expect(mocks.updateBalances).toHaveBeenCalledTimes(1)
    refresh.stop()
  })
})
