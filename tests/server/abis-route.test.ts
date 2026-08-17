import { afterEach, describe, expect, it, vi } from 'vitest'
import vaultLensSnapshot from '~/server/assets/manifests/abis/VaultLens.json'

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
}))

vi.mock('h3', () => ({
  createError: (error: unknown) => error,
  getRouterParam: (event: { params?: Record<string, string> }, name: string) =>
    event.params?.[name],
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

const BRANCH_ENV_KEYS = [
  'EULER_SDK_EULER_INTERFACES_BRANCH',
  'NUXT_PUBLIC_EULER_INTERFACES_BRANCH',
  'NUXT_PUBLIC_CONFIG_EULER_INTERFACES_BRANCH',
  'NUXT_PUBLIC_CONFIG_EULER_ABIS_BASE_URL',
] as const

const originalEnv = Object.fromEntries(BRANCH_ENV_KEYS.map(key => [key, process.env[key]]))

// The module holds cache state, so every test imports a fresh copy.
const importRoute = async () => {
  vi.resetModules()
  return import('~/server/api/internal/abis/[contract].get')
}

describe('/api/internal/abis/[contract]', () => {
  afterEach(() => {
    for (const key of BRANCH_ENV_KEYS) {
      const original = originalEnv[key]
      if (original === undefined) Reflect.deleteProperty(process.env, key)
      else process.env[key] = original
    }
    vi.clearAllMocks()
  })

  it('fetches the contract ABI from the configured interfaces branch', async () => {
    process.env.EULER_SDK_EULER_INTERFACES_BRANCH = 'account-lens-update'
    const abi = [{ type: 'function', name: 'getVaultInfoFull' }]
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(abi))

    const { refreshAbi } = await importRoute()

    await expect(refreshAbi('VaultLens')).resolves.toEqual(abi)
    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      'https://raw.githubusercontent.com/euler-xyz/euler-interfaces/refs/heads/account-lens-update/abis/VaultLens.json',
    )
  })

  it('prioritizes the explicit ABIs base URL over a configured interfaces branch', async () => {
    process.env.EULER_SDK_EULER_INTERFACES_BRANCH = 'account-lens-update'
    process.env.NUXT_PUBLIC_CONFIG_EULER_ABIS_BASE_URL = 'https://abis.example/mirror/'
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json([]))

    const { refreshAbi } = await importRoute()
    await refreshAbi('AccountLens')

    expect(mocks.fetchWithTimeout).toHaveBeenCalledWith(
      'https://abis.example/mirror/AccountLens.json',
    )
  })

  it('rejects a non-array upstream payload', async () => {
    for (const key of BRANCH_ENV_KEYS) Reflect.deleteProperty(process.env, key)
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json({ error: 'nope' }))

    const { refreshAbi } = await importRoute()

    await expect(refreshAbi('VaultLens')).rejects.toThrow('non-array payload')
  })

  it('serves the build-time snapshot when upstream fails and no cache exists', async () => {
    mocks.fetchWithTimeout.mockRejectedValueOnce(new Error('upstream down'))

    const { loadAbi } = await importRoute()

    await expect(loadAbi('VaultLens')).resolves.toEqual(vaultLensSnapshot)
  })

  it('serves fresh cache without refetching', async () => {
    const abi = [{ type: 'function', name: 'computeAPYs' }]
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(abi))

    const { loadAbi } = await importRoute()
    await loadAbi('UtilsLens')
    await expect(loadAbi('UtilsLens')).resolves.toEqual(abi)

    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(1)
  })

  it('404s on a contract outside the allowlist', async () => {
    const route = await importRoute()

    await expect(
      route.default({ params: { contract: 'NotALens' } } as never),
    ).rejects.toMatchObject({ statusCode: 404 })

    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled()
  })

  it('serves an allowlisted contract through the handler', async () => {
    const abi = [{ type: 'function', name: 'getEVCAccountInfo' }]
    mocks.fetchWithTimeout.mockResolvedValueOnce(Response.json(abi))

    const route = await importRoute()

    await expect(
      route.default({ params: { contract: 'AccountLens' } } as never),
    ).resolves.toEqual(abi)
  })
})
