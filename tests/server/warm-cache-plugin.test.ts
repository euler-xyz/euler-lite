import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  peekEulerChains: vi.fn((): unknown[] | undefined => undefined),
  refreshTokenList: vi.fn((_chainId: number) => Promise.resolve([])),
  refreshChainVaults: vi.fn((_chainId: number) => Promise.resolve()),
}))

vi.mock('~/server/api/internal/labels/[file].get', () => ({
  LABEL_FILES: [],
  refreshLabelFile: () => Promise.resolve(),
}))

vi.mock('~/server/api/internal/euler-chains.get', () => ({
  refreshEulerChains: () => Promise.resolve([]),
  peekEulerChains: mocks.peekEulerChains,
}))

vi.mock('~/server/api/internal/abis/[contract].get', () => ({
  ABI_CONTRACTS: [],
  refreshAbi: () => Promise.resolve(),
}))

vi.mock('~/server/api/internal/token-list.get', () => ({
  refreshTokenList: mocks.refreshTokenList,
}))

vi.mock('~/server/utils/vaults-cache', () => ({
  refreshChainVaults: mocks.refreshChainVaults,
}))

vi.mock('~/utils/api-url-env', () => ({
  readDisableServerVaultCache: () => false,
  readV3ApiUrl: () => '',
  warnIfVaultSourceNeedsV3: () => {},
}))

vi.mock('~/utils/chain-env', () => ({
  getEnabledChainIds: () => [1, 146, 8453],
}))

vi.mock('~/server/utils/log', () => ({
  reportStatus: () => {},
}))

vi.mock('~/server/utils/logger', () => ({
  logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn() },
}))

const REWARM_INTERVAL_MS = 5 * 60_000
const WARM_LATCH_KEY = '__eulerLiteWarmCacheStarted'

const bootPlugin = async () => {
  vi.resetModules()
  const { default: plugin } = await import('~/server/plugins/warm-cache')
  plugin({} as never)
}

const warmedChains = (fn: typeof mocks.refreshTokenList | typeof mocks.refreshChainVaults) =>
  [...new Set(fn.mock.calls.map(([chainId]) => chainId))].sort((a, b) => a - b)

describe('warm-cache plugin deprecated chains', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    Reflect.deleteProperty(globalThis, WARM_LATCH_KEY)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllEnvs()
    Reflect.deleteProperty(globalThis, WARM_LATCH_KEY)
    mocks.peekEulerChains.mockReset().mockReturnValue(undefined)
    mocks.refreshTokenList.mockClear()
    mocks.refreshChainVaults.mockClear()
  })

  it('skips chains listed in DEPRECATED_CHAINS', async () => {
    vi.stubEnv('DEPRECATED_CHAINS', '146')
    await bootPlugin()
    await vi.advanceTimersByTimeAsync(0)

    expect(warmedChains(mocks.refreshTokenList)).toEqual([1, 8453])
    expect(warmedChains(mocks.refreshChainVaults)).toEqual([1, 8453])
  })

  it('skips chains the registry marks deprecated', async () => {
    mocks.peekEulerChains.mockReturnValue([
      { chainId: 1, status: 'production' },
      { chainId: 146, status: 'deprecated' },
    ])
    await bootPlugin()
    await vi.advanceTimersByTimeAsync(0)

    expect(warmedChains(mocks.refreshTokenList)).toEqual([1, 8453])
    expect(warmedChains(mocks.refreshChainVaults)).toEqual([1, 8453])
  })

  it('picks up a registry deprecation on the next cycle', async () => {
    await bootPlugin()
    await vi.advanceTimersByTimeAsync(0)
    expect(warmedChains(mocks.refreshTokenList)).toEqual([1, 146, 8453])

    mocks.refreshTokenList.mockClear()
    mocks.refreshChainVaults.mockClear()
    mocks.peekEulerChains.mockReturnValue([{ chainId: 8453, status: 'deprecated' }])
    await vi.advanceTimersByTimeAsync(REWARM_INTERVAL_MS)

    expect(warmedChains(mocks.refreshTokenList)).toEqual([1, 146])
    expect(warmedChains(mocks.refreshChainVaults)).toEqual([1, 146])
  })
})
