import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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

const ADDR = `0x${'11'.repeat(20)}`

const validManifest = () => [{
  chainId: 1,
  addresses: {
    coreAddrs: { eVaultFactory: ADDR, evc: ADDR, permit2: ADDR },
    lensAddrs: { accountLens: ADDR, oracleLens: ADDR, utilsLens: ADDR, vaultLens: ADDR },
  },
}]

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
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(validManifest()))

    const { refreshEulerChains } = await importRoute()
    await refreshEulerChains()

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      'https://deployments.example/EulerChains.json',
    )
  })

  it('uses the configured interfaces branch when no direct URL is set', async () => {
    process.env.EULER_SDK_EULER_INTERFACES_BRANCH = 'account-lens-update'
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(validManifest()))

    const { refreshEulerChains } = await importRoute()
    await refreshEulerChains()

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/euler-xyz/euler-interfaces/refs/heads/account-lens-update/EulerChains.json',
    )
  })

  it('falls back to the master branch when nothing is configured', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(validManifest()))

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

  it('throws when upstream fails and no cache exists', async () => {
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error('upstream down'))

    const { loadEulerChains } = await importRoute()

    await expect(loadEulerChains()).rejects.toThrow('upstream down')
  })

  it('throws on a non-ok upstream response with no cache', async () => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(new Response('rate limited', { status: 429 }))

    const { loadEulerChains } = await importRoute()

    await expect(loadEulerChains()).rejects.toThrow('Upstream returned 429')
  })

  it('serves stale cache during a prolonged outage, up to the manifest window', async () => {
    vi.useFakeTimers()
    const upstreamData = validManifest()
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(upstreamData))

    const { loadEulerChains } = await importRoute()
    await expect(loadEulerChains()).resolves.toEqual(upstreamData)

    // Past the 5-min TTL but well within the manifest stale window.
    vi.advanceTimersByTime(60 * 60_000)
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error('upstream down'))
    await expect(loadEulerChains()).resolves.toEqual(upstreamData)

    // Past the 7-day stale window nothing is left to serve.
    vi.advanceTimersByTime(8 * 24 * 60 * 60_000)
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error('upstream down'))
    await expect(loadEulerChains()).rejects.toThrow('upstream down')
  })

  it('returns fresh cache without refetching', async () => {
    const upstreamData = validManifest()
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(upstreamData))

    const { loadEulerChains } = await importRoute()
    await loadEulerChains()
    await expect(loadEulerChains()).resolves.toEqual(upstreamData)

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1)
  })

  it.each([
    ['non-array payload', { error: 'nope' }],
    ['empty manifest', []],
    ['entries without chainId/addresses', [{}]],
    ['non-object addresses', [{ chainId: 1, addresses: 'x' }]],
    ['array addresses', [{ chainId: 1, addresses: [ADDR] }]],
    ['empty addresses object', [{ chainId: 1, addresses: {} }]],
    ['missing coreAddrs keys', [{
      chainId: 1,
      addresses: {
        coreAddrs: { eVaultFactory: ADDR, permit2: ADDR },
        lensAddrs: { accountLens: ADDR, oracleLens: ADDR, utilsLens: ADDR, vaultLens: ADDR },
      },
    }]],
    ['non-address lens value', [{
      chainId: 1,
      addresses: {
        coreAddrs: { eVaultFactory: ADDR, evc: ADDR, permit2: ADDR },
        lensAddrs: { accountLens: ADDR, oracleLens: ADDR, utilsLens: ADDR, vaultLens: 'not-an-address' },
      },
    }]],
    ['one bad entry among valid ones', [...validManifest(), { chainId: 2, addresses: {} }]],
  ])('rejects an unusable 200 payload with no cache (%s)', async (_label, payload) => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(payload))

    const { loadEulerChains } = await importRoute()

    await expect(loadEulerChains()).rejects.toThrow('invalid deployment manifest')
  })

  it('keeps serving the last-known-good manifest when a later 200 is unusable', async () => {
    vi.useFakeTimers()
    const upstreamData = validManifest()
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(upstreamData))

    const { loadEulerChains } = await importRoute()
    await expect(loadEulerChains()).resolves.toEqual(upstreamData)

    // Past the TTL an array-shaped but empty 200 must not overwrite the
    // valid entry — the stale value wins.
    vi.advanceTimersByTime(6 * 60_000)
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([]))
    await expect(loadEulerChains()).resolves.toEqual(upstreamData)

    // A non-empty but semantically unusable manifest must not overwrite
    // the valid entry either.
    vi.advanceTimersByTime(6 * 60_000)
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([{ chainId: 1, addresses: {} }]))
    await expect(loadEulerChains()).resolves.toEqual(upstreamData)

    // And the valid entry's timestamp was not reset by the poison responses.
    vi.advanceTimersByTime(6 * 60_000)
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([{ chainId: 0 }]))
    await expect(loadEulerChains()).resolves.toEqual(upstreamData)
  })
})
