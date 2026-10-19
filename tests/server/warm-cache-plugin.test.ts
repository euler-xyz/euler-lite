import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  refreshEulerChains: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
  peekEulerChains: vi.fn((): unknown[] | undefined => undefined),
  refreshPublicLabelsBundle: vi.fn((_chainId: number) => Promise.resolve()),
  refreshTokenList: vi.fn((_chainId: number) => Promise.resolve([])),
  refreshChainVaults: vi.fn((_chainId: number) => Promise.resolve()),
}))

vi.mock('~/server/utils/public-labels-source', () => ({
  refreshPublicLabelsBundle: mocks.refreshPublicLabelsBundle,
}))

vi.mock('~/server/api/internal/euler-chains.get', () => ({
  refreshEulerChains: mocks.refreshEulerChains,
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
  isV3BackendEnabled: () => false,
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
const UPSTREAM_FETCH_TIMEOUT_MS = 10_000
const REGISTRY = [
  { chainId: 1, status: 'production' },
  { chainId: 146, status: 'deprecated' },
]

const pendingManifest = () => {
  let settle: { resolve: () => void, reject: (err: Error) => void } = { resolve: () => {}, reject: () => {} }
  const promise = new Promise<unknown[]>((resolve, reject) => {
    settle = { resolve: () => resolve(REGISTRY), reject }
  })
  mocks.refreshEulerChains.mockReturnValue(promise)
  return settle
}
const WARM_LATCH_KEY = '__eulerLiteWarmCacheStarted'

const bootPlugin = async () => {
  vi.resetModules()
  const { default: plugin } = await import('~/server/plugins/warm-cache')
  plugin({} as never)
}

const warmedChains = (fn: typeof mocks.refreshPublicLabelsBundle | typeof mocks.refreshTokenList | typeof mocks.refreshChainVaults) =>
  [...new Set(fn.mock.calls.map(([chainId]) => chainId))].sort((a, b) => a - b)

describe('warm-cache plugin deprecated chains', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubEnv('DEPRECATED_CHAINS', '')
    Reflect.deleteProperty(globalThis, WARM_LATCH_KEY)
  })

  afterEach(() => {
    vi.clearAllTimers()
    vi.useRealTimers()
    vi.unstubAllEnvs()
    Reflect.deleteProperty(globalThis, WARM_LATCH_KEY)
    mocks.peekEulerChains.mockReset().mockReturnValue(undefined)
    mocks.refreshEulerChains.mockReset().mockImplementation(() => Promise.resolve([]))
    mocks.refreshTokenList.mockClear()
    mocks.refreshPublicLabelsBundle.mockClear()
    mocks.refreshChainVaults.mockClear()
  })

  it('skips chains listed in DEPRECATED_CHAINS', async () => {
    vi.stubEnv('DEPRECATED_CHAINS', '146')
    await bootPlugin()
    await vi.advanceTimersByTimeAsync(0)

    expect(warmedChains(mocks.refreshTokenList)).toEqual([1, 8453])
    expect(warmedChains(mocks.refreshPublicLabelsBundle)).toEqual([1, 8453])
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

  it('holds the first per-chain warms until the cold-start manifest read answers', async () => {
    const manifest = pendingManifest()
    await bootPlugin()
    await vi.advanceTimersByTimeAsync(0)

    expect(mocks.refreshTokenList).not.toHaveBeenCalled()
    expect(mocks.refreshChainVaults).not.toHaveBeenCalled()

    mocks.peekEulerChains.mockReturnValue(REGISTRY)
    manifest.resolve()
    await vi.advanceTimersByTimeAsync(0)

    expect(warmedChains(mocks.refreshTokenList)).toEqual([1, 8453])
    expect(warmedChains(mocks.refreshChainVaults)).toEqual([1, 8453])
  })

  it('warms the env chain list when the cold-start manifest read fails', async () => {
    const manifest = pendingManifest()
    await bootPlugin()
    manifest.reject(new Error('upstream down'))
    await vi.advanceTimersByTimeAsync(0)

    expect(warmedChains(mocks.refreshTokenList)).toEqual([1, 146, 8453])
    expect(warmedChains(mocks.refreshChainVaults)).toEqual([1, 146, 8453])
  })

  it('warms the env chain list when the cold-start manifest read is too slow', async () => {
    pendingManifest()
    await bootPlugin()
    await vi.advanceTimersByTimeAsync(UPSTREAM_FETCH_TIMEOUT_MS - 1)
    expect(mocks.refreshTokenList).not.toHaveBeenCalled()

    await vi.advanceTimersByTimeAsync(1)

    expect(warmedChains(mocks.refreshTokenList)).toEqual([1, 146, 8453])
    expect(warmedChains(mocks.refreshChainVaults)).toEqual([1, 146, 8453])
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
