import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTtlCache } from '~/server/utils/cache'
import { chainReadPolicyKey } from '~/utils/chain-policy'

const mocks = vi.hoisted(() => ({
  policy: { deprecated: false, onchain: false, metadataOnly: false },
  refresh: vi.fn(),
  get: vi.fn(),
  getStale: vi.fn(),
}))

vi.mock('h3', () => ({
  createError: (args: { statusCode: number, statusMessage: string }) => Object.assign(new Error(args.statusMessage), args),
  setResponseHeader: vi.fn(),
}))
vi.mock('~/server/utils/rate-limit', () => ({ createRateLimiter: () => ({ consume: vi.fn() }) }))
vi.mock('~/server/utils/resolve-chain-id', () => ({ resolveChainId: () => 999 }))
vi.mock('~/server/utils/chain-policy', () => ({ loadServerChainReadPolicy: async () => mocks.policy }))
vi.mock('~/utils/api-url-env', () => ({ readDisableServerVaultCache: () => false }))
vi.mock('~/server/utils/vaults-cache', () => ({
  refreshChainVaults: mocks.refresh,
  vaultsCache: { get: mocks.get, getStale: mocks.getStale },
  vaultsCacheKey: (chainId: number, policy: typeof mocks.policy) => `${chainId}:${chainReadPolicyKey(policy)}`,
}))

describe('vault snapshot route policy', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.policy = { deprecated: false, onchain: false, metadataOnly: false }
    mocks.refresh.mockReset()
  })

  it('bypasses an indexed snapshot immediately when the chain switches to retired routing', async () => {
    const cache = createTtlCache<object>({ ttlMs: 300_000 })
    mocks.get.mockImplementation(cache.get)
    mocks.getStale.mockImplementation(cache.getStale)
    const active = { marker: 'active' }
    cache.set(`999:${chainReadPolicyKey(mocks.policy)}`, active)
    const { default: handler } = await import('~/server/api/internal/vaults.get')
    expect(await handler({} as never)).toBe(active)
    expect(mocks.refresh).not.toHaveBeenCalled()

    mocks.policy = { deprecated: true, onchain: true, metadataOnly: true }
    const deprecated = { marker: 'deprecated' }
    mocks.refresh.mockResolvedValue(deprecated)
    expect(await handler({} as never)).toBe(deprecated)
    expect(mocks.refresh).toHaveBeenCalledExactlyOnceWith(999)
    mocks.refresh.mockRejectedValue(new Error('RPC unavailable'))
    await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 502 })
  })
})
