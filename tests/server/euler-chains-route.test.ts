import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import eulerChainsSnapshot from '~/server/assets/manifests/EulerChains.json'

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
}))

vi.mock('h3', () => ({
  createError: (error: unknown) => error,
  setResponseHeader: vi.fn(),
}))

vi.mock('~/server/utils/fetchWithTimeout', () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}))

vi.mock('~/server/utils/rate-limit', () => ({
  createRateLimiter: () => ({ consume: vi.fn() }),
}))

vi.mock('~/server/utils/logger', () => ({
  logger: { warn: vi.fn(), error: vi.fn() },
}))

const ENV_KEYS = [
  'EULER_SDK_EULER_INTERFACES_BRANCH',
  'NUXT_PUBLIC_EULER_INTERFACES_BRANCH',
  'NUXT_PUBLIC_CONFIG_EULER_INTERFACES_BRANCH',
  'NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL',
] as const

const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

// The module holds cache state, so every test imports a fresh copy.
const importRoute = async () => {
  vi.resetModules()
  return import('~/server/api/internal/euler-chains.get')
}

describe('/api/internal/euler-chains upstream selection', () => {
  beforeEach(() => {
    for (const key of ENV_KEYS) Reflect.deleteProperty(process.env, key)
  })

  afterEach(() => {
    for (const key of ENV_KEYS) {
      const original = originalEnv[key]
      if (original === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = original
    }
    vi.clearAllMocks()
  })

  it('prioritizes the direct EulerChains URL over a configured interfaces branch', async () => {
    process.env.EULER_SDK_EULER_INTERFACES_BRANCH = 'account-lens-update'
    process.env.NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL = 'https://deployments.example/EulerChains.json'
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([]))

    const { refreshEulerChains } = await importRoute()
    await refreshEulerChains()

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      'https://deployments.example/EulerChains.json',
    )
  })

  it('uses the configured interfaces branch when no direct URL is set', async () => {
    process.env.EULER_SDK_EULER_INTERFACES_BRANCH = 'account-lens-update'
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([]))

    const { refreshEulerChains } = await importRoute()
    await refreshEulerChains()

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/euler-xyz/euler-interfaces/refs/heads/account-lens-update/EulerChains.json',
    )
  })

  it('falls back to the master branch when nothing is configured', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([]))

    const { refreshEulerChains } = await importRoute()
    await refreshEulerChains()

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/euler-xyz/euler-interfaces/refs/heads/master/EulerChains.json',
    )
  })
})

describe('/api/internal/euler-chains resolution chain', () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      const original = originalEnv[key]
      if (original === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = original
    }
    vi.clearAllMocks()
    vi.useRealTimers()
  })

  it('serves the build-time snapshot when upstream fails and no cache exists', async () => {
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error('upstream down'))

    const { loadEulerChains } = await importRoute()

    await expect(loadEulerChains()).resolves.toEqual(eulerChainsSnapshot)
  })

  it('serves the snapshot on a non-ok upstream response with no cache', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(new Response('rate limited', { status: 429 }))

    const { loadEulerChains } = await importRoute()

    await expect(loadEulerChains()).resolves.toEqual(eulerChainsSnapshot)
  })

  it('serves stale cache over the snapshot during a prolonged outage', async () => {
    vi.useFakeTimers()
    const upstreamData = [{ chainId: 1 }]
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(upstreamData))

    const { loadEulerChains } = await importRoute()
    await expect(loadEulerChains()).resolves.toEqual(upstreamData)

    // Past the 5-min TTL but well within the manifest stale window.
    vi.advanceTimersByTime(60 * 60_000)
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error('upstream down'))
    await expect(loadEulerChains()).resolves.toEqual(upstreamData)

    // Past the 7-day stale window the snapshot takes over.
    vi.advanceTimersByTime(8 * 24 * 60 * 60_000)
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error('upstream down'))
    await expect(loadEulerChains()).resolves.toEqual(eulerChainsSnapshot)
  })

  it('returns fresh cache without refetching', async () => {
    const upstreamData = [{ chainId: 1 }]
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(upstreamData))

    const { loadEulerChains } = await importRoute()
    await loadEulerChains()
    await expect(loadEulerChains()).resolves.toEqual(upstreamData)

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1)
  })
})
