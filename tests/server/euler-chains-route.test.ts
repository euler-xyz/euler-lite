import { afterEach, describe, expect, it, vi } from 'vitest'

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
  logger: { warn: vi.fn() },
}))

const ENV_KEYS = [
  'EULER_SDK_EULER_INTERFACES_BRANCH',
  'NUXT_PUBLIC_EULER_INTERFACES_BRANCH',
  'NUXT_PUBLIC_CONFIG_EULER_INTERFACES_BRANCH',
  'NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL',
] as const

const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))
const { refreshEulerChains } = await import('~/server/api/internal/euler-chains.get')

describe('/api/internal/euler-chains upstream selection', () => {
  afterEach(() => {
    for (const key of ENV_KEYS) {
      const original = originalEnv[key]
      if (original === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = original
    }
    vi.clearAllMocks()
  })

  it('prioritizes the configured interfaces branch over the direct EulerChains URL', async () => {
    process.env.EULER_SDK_EULER_INTERFACES_BRANCH = 'account-lens-update'
    process.env.NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL = 'https://deployments.example/EulerChains.json'
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([]))

    await refreshEulerChains()

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/euler-xyz/euler-interfaces/refs/heads/account-lens-update/EulerChains.json',
    )
  })

  it('uses the direct EulerChains URL when no interfaces branch is configured', async () => {
    for (const key of ENV_KEYS.slice(0, 3)) Reflect.deleteProperty(process.env, key)
    process.env.NUXT_PUBLIC_CONFIG_EULER_CHAINS_URL = 'https://deployments.example/EulerChains.json'
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([]))

    await refreshEulerChains()

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      'https://deployments.example/EulerChains.json',
    )
  })
})
