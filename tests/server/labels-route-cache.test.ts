/**
 * Cache-layer tests for the two labels endpoints.
 *
 * Both routes must read through the shared 5-minute TTL cache; only the
 * warm-cache primitive (`refreshLabelFile`) is allowed to force an upstream
 * fetch. The path-shape route is the one the SDK's default
 * `eulerLabelsBaseUrl` template hits, so a regression there sends every SDK
 * label read to GitHub/CloudFront and reduces the warm-cache prewarm to a
 * stale fallback. Each test uses its own chain id because the cache and
 * in-flight maps are module-level singletons.
 */
import type { H3Event } from 'h3'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  consume: vi.fn(),
  fetchWithTimeout: vi.fn(),
}))

vi.mock('h3', () => ({
  createError: (error: unknown) => error,
  getQuery: (event: TestEvent) => event.query ?? {},
  getRouterParam: (event: TestEvent, name: string) => event.params[name],
  setResponseHeader: () => undefined,
}))

vi.mock('~/server/utils/rate-limit', () => ({
  createRateLimiter: () => ({ consume: mocks.consume }),
}))

vi.mock('~/server/utils/fetchWithTimeout', () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}))

vi.mock('~/server/utils/log', () => ({
  reportStatus: () => undefined,
}))

type TestEvent = H3Event & {
  params: Record<string, string>
  query?: Record<string, string>
}

const queryModule = await import('~/server/api/internal/labels/[file].get')
const queryHandler = queryModule.default
const { refreshLabelFile } = queryModule
const pathHandler = (await import('~/server/api/internal/labels/[chainId]/[file].get')).default

const pathEvent = (chainId: string, file: string) =>
  ({ params: { chainId, file } }) as unknown as TestEvent

const queryEvent = (chainId: string, file: string) =>
  ({ params: { file }, query: { chainId } }) as unknown as TestEvent

const respondWith = (payload: unknown) => {
  mocks.fetchWithTimeout.mockResolvedValue({
    ok: true,
    status: 200,
    json: async () => payload,
  })
}

beforeEach(() => {
  mocks.fetchWithTimeout.mockReset()
})

describe('path-shape labels route — cache read-through', () => {
  it('serves the second request for the same file from cache', async () => {
    respondWith({ vaultA: { name: 'Vault A' } })

    const first = await pathHandler(pathEvent('1', 'products.json'))
    const second = await pathHandler(pathEvent('1', 'products.json'))

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
  })

  it('collapses concurrent cache-miss requests onto one upstream fetch', async () => {
    respondWith({})

    await Promise.all([
      pathHandler(pathEvent('2', 'entities.json')),
      pathHandler(pathEvent('2', 'entities.json')),
      pathHandler(pathEvent('2', 'entities.json')),
    ])

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1)
  })

  it('serves a warm-cache-populated entry without going upstream', async () => {
    respondWith([{ symbol: 'USDC' }])
    await refreshLabelFile(3, 'points.json')
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1)

    const served = await pathHandler(pathEvent('3', 'points.json'))

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1)
    expect(served).toEqual([{ symbol: 'USDC' }])
  })

  it('keeps separate cache entries per chain and per file', async () => {
    respondWith({})

    await pathHandler(pathEvent('4', 'products.json'))
    await pathHandler(pathEvent('5', 'products.json'))
    await pathHandler(pathEvent('4', 'entities.json'))

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(3)
  })

  it('reads through the same cache entry as the query-shape route', async () => {
    respondWith({ vaultB: { name: 'Vault B' } })

    await queryHandler(queryEvent('6', 'products.json'))
    const viaPath = await pathHandler(pathEvent('6', 'products.json'))

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1)
    expect(viaPath).toEqual({ vaultB: { name: 'Vault B' } })
  })

  it('rejects a chainId that is neither an integer nor "all"', async () => {
    await expect(pathHandler(pathEvent('mainnet', 'products.json')))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled()
  })

  it('rejects a file outside LABEL_FILES', async () => {
    await expect(pathHandler(pathEvent('1', 'secrets.json')))
      .rejects.toMatchObject({ statusCode: 400 })
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled()
  })
})

describe('refreshLabelFile — warm-cache force refresh', () => {
  it('still fetches upstream when a fresh entry exists', async () => {
    respondWith({ first: true })
    await refreshLabelFile(7, 'products.json')

    respondWith({ second: true })
    const refreshed = await refreshLabelFile(7, 'products.json')

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(2)
    expect(refreshed).toEqual({ second: true })
  })

  it('serves the stale entry when a later upstream fetch fails', async () => {
    respondWith({ cached: true })
    await refreshLabelFile(8, 'products.json')

    mocks.fetchWithTimeout.mockRejectedValue(new Error('upstream down'))
    const served = await refreshLabelFile(8, 'products.json')

    expect(served).toEqual({ cached: true })
  })
})
