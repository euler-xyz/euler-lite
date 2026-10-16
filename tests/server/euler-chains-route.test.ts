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
    vi.unstubAllEnvs()
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
    ['non-array payload', { error: 'nope' }, 'invalid deployment manifest'],
    ['empty manifest', [], 'invalid deployment manifest'],
    ['entries without chainId/addresses', [{}], 'invalid deployment manifest'],
    ['non-object addresses', [{ chainId: 1, addresses: 'x' }], 'invalid deployment manifest'],
    ['array addresses', [{ chainId: 1, addresses: [ADDR] }], 'invalid deployment manifest'],
    ['empty addresses object', [{ chainId: 1, addresses: {} }], 'invalid deployment manifest'],
    ['missing coreAddrs keys', [{
      chainId: 1,
      addresses: {
        coreAddrs: { eVaultFactory: ADDR, permit2: ADDR },
        lensAddrs: { accountLens: ADDR, oracleLens: ADDR, utilsLens: ADDR, vaultLens: ADDR },
      },
    }], 'invalid deployment manifest'],
    ['non-address lens value', [{
      chainId: 1,
      addresses: {
        coreAddrs: { eVaultFactory: ADDR, evc: ADDR, permit2: ADDR },
        lensAddrs: { accountLens: ADDR, oracleLens: ADDR, utilsLens: ADDR, vaultLens: 'not-an-address' },
      },
    }], 'invalid deployment manifest'],
  ])('rejects an unusable 200 payload with no cache (%s)', async (_label, payload, message) => {
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(payload))

    const { loadEulerChains } = await importRoute()

    await expect(loadEulerChains()).rejects.toThrow(message)
  })

  it('admits valid entries while dropping invalid ones for non-enabled chains', async () => {
    // A routine sparse addition to euler-interfaces (a new chain this
    // deployment does not enable) must not freeze the whole manifest.
    mocks.fetchWithTimeout.mockResolvedValueOnce(
      Response.json([...validManifest(), { chainId: 2, addresses: {} }]),
    )

    const { loadEulerChains } = await importRoute()

    await expect(loadEulerChains()).resolves.toEqual(validManifest())
  })

  it('serves usable chains when another configured chain has an invalid entry', async () => {
    vi.stubEnv('RPC_URL_1', 'https://ethereum.example')
    vi.stubEnv('RPC_URL_8453', 'https://base.example')
    mocks.fetchWithTimeout.mockResolvedValueOnce(
      Response.json([...validManifest(), { chainId: 8453, addresses: {} }]),
    )

    const { loadEulerChains } = await importRoute()

    await expect(loadEulerChains()).resolves.toEqual(validManifest())
  })

  it('serves usable chains when another configured chain is missing from the manifest', async () => {
    vi.stubEnv('RPC_URL_1', 'https://ethereum.example')
    vi.stubEnv('RPC_URL_8453', 'https://base.example')
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(validManifest()))

    const { loadEulerChains } = await importRoute()

    await expect(loadEulerChains()).resolves.toEqual(validManifest())
  })

  it('refreshes healthy chains while an invalid row keeps only its original stale lifetime', async () => {
    vi.useFakeTimers()
    const original = validManifest()[0]
    const healthy = { ...original, chainId: 2 }
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([original, healthy]))
    const { loadEulerChains, refreshEulerChains, peekEulerChains } = await importRoute()
    await loadEulerChains()

    vi.advanceTimersByTime(6 * 24 * 60 * 60_000)
    const updated = { ...healthy, status: 'deprecated' }
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([{ chainId: 1, addresses: {} }, updated]))
    const partial = await refreshEulerChains()
    expect(partial).toEqual(expect.arrayContaining([original, updated]))
    expect(partial).toHaveLength(2)

    vi.advanceTimersByTime(2 * 24 * 60 * 60_000)
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([{ chainId: 1, addresses: {} }, updated]))
    await expect(refreshEulerChains()).resolves.toEqual([updated])
    expect(peekEulerChains()).toEqual([updated])
  })

  it('does not serve expired invalid rows from an otherwise fresh manifest', async () => {
    vi.useFakeTimers()
    const original = validManifest()[0]
    const healthy = { ...original, chainId: 2 }
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([original, healthy]))
    const { loadEulerChains, refreshEulerChains, peekEulerChains } = await importRoute()
    await loadEulerChains()

    vi.advanceTimersByTime(7 * 24 * 60 * 60_000 + 4 * 60_000)
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([{ chainId: 1, addresses: {} }, healthy]))
    expect(await refreshEulerChains()).toHaveLength(2)

    vi.advanceTimersByTime(2 * 60_000)
    expect(peekEulerChains()).toEqual([healthy])
    await expect(loadEulerChains()).resolves.toEqual([healthy])
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(2)
  })

  it('removes omitted chains and does not resurrect their cached entries from invalid re-additions', async () => {
    const original = validManifest()[0]
    const healthy = { ...original, chainId: 2 }
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([original, healthy]))
    const { loadEulerChains, refreshEulerChains } = await importRoute()
    await loadEulerChains()

    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([healthy]))
    await expect(refreshEulerChains()).resolves.toEqual([healthy])

    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([{ chainId: 1, addresses: {} }, healthy]))
    await expect(refreshEulerChains()).resolves.toEqual([healthy])

    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([original, healthy]))
    await expect(refreshEulerChains()).resolves.toEqual([original, healthy])
  })

  it('passes the registry status and explorer URL through unchanged', async () => {
    const upstreamData = [{
      ...validManifest()[0],
      status: 'deprecated',
      explorerUrl: 'https://etherscan.io',
    }]
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(upstreamData))

    const { loadEulerChains } = await importRoute()

    await expect(loadEulerChains()).resolves.toEqual(upstreamData)
  })

  it('peeks the cached manifest without fetching, fresh or stale', async () => {
    vi.useFakeTimers()
    const upstreamData = validManifest()
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(upstreamData))

    const { loadEulerChains, peekEulerChains } = await importRoute()
    expect(peekEulerChains()).toBeUndefined()

    await loadEulerChains()
    expect(peekEulerChains()).toEqual(upstreamData)

    vi.advanceTimersByTime(60 * 60_000)
    expect(peekEulerChains()).toEqual(upstreamData)

    vi.advanceTimersByTime(8 * 24 * 60 * 60_000)
    expect(peekEulerChains()).toBeUndefined()
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1)
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
