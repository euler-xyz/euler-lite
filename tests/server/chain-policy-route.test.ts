import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { setResponseHeader } from 'h3'

const mocks = vi.hoisted(() => ({ loadEulerChains: vi.fn(), fetch: vi.fn() }))
vi.mock('~/server/api/internal/euler-chains.get', () => ({ loadEulerChains: mocks.loadEulerChains }))
vi.mock('~/server/utils/fetchWithTimeout', async original => ({
  ...await original<typeof import('~/server/utils/fetchWithTimeout')>(), fetchWithTimeout: mocks.fetch,
}))
vi.mock('~/server/utils/rate-limit', () => ({ createRateLimiter: () => ({ consume: vi.fn() }) }))
vi.mock('~/server/utils/resolve-chain-id', () => ({ resolveChainId: () => 146 }))
vi.mock('h3', () => ({
  createError: (args: { statusCode: number, statusMessage: string }) => Object.assign(new Error(args.statusMessage), args),
  setResponseHeader: vi.fn(),
}))

describe('independent chain policy endpoint', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.stubEnv('V3_API_URL', 'https://v3.example.test')
    vi.stubEnv('DISABLE_V3', 'false')
    vi.stubEnv('RPC_URL_146', 'https://rpc.example.test')
    vi.stubEnv('LABELS_SOURCE', 'v3')
    vi.stubEnv('DEPRECATED_CHAINS', '')
    vi.stubEnv('ONCHAIN_SDK_CHAINS', '')
    mocks.loadEulerChains.mockReset()
    mocks.fetch.mockReset().mockImplementation(async () => Response.json({ data: [{ id: 146, capabilities: ['indexing'] }] }))
    vi.clearAllMocks()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('keeps deprecated chains on V3 while the catalog supports indexing', async () => {
    const { default: handler } = await import('~/server/api/internal/chain-policy.get')
    for (const status of ['production', 'deprecated', 'production']) {
      mocks.loadEulerChains.mockResolvedValue([{ chainId: 146, status }])
      const expected = status === 'deprecated'
      expect(await handler({} as never)).toEqual({ chainId: 146, policy: { deprecated: expected, onchain: false, metadataOnly: false } })
    }
    expect(setResponseHeader).toHaveBeenCalledWith({}, 'Cache-Control', 'no-store')
  })

  it('follows catalog retirement/reactivation and preserves retired routing during an outage', async () => {
    mocks.loadEulerChains.mockResolvedValue([{ chainId: 146, status: 'deprecated' }])
    const { default: handler } = await import('~/server/api/internal/chain-policy.get')
    const read = () => handler({} as never)
    expect(await read()).toMatchObject({ policy: { deprecated: true, onchain: false, metadataOnly: false } })
    vi.advanceTimersByTime(5 * 60_000)
    mocks.fetch.mockResolvedValueOnce(Response.json({ data: [] }))
    expect(await read()).toMatchObject({ policy: { deprecated: true, onchain: true, metadataOnly: true } })
    vi.advanceTimersByTime(5 * 60_000)
    mocks.fetch.mockRejectedValueOnce(new Error('catalog outage'))
    expect(await read()).toMatchObject({ policy: { deprecated: true, onchain: true, metadataOnly: true } })
    vi.advanceTimersByTime(30_000)
    expect(await read()).toMatchObject({ policy: { deprecated: true, onchain: false, metadataOnly: false } })
  })

  it('returns unavailable on a cold catalog outage without inventing a routing policy', async () => {
    mocks.loadEulerChains.mockResolvedValue([{ chainId: 146, status: 'deprecated' }])
    mocks.fetch.mockRejectedValueOnce(new Error('catalog outage'))
    const { default: handler } = await import('~/server/api/internal/chain-policy.get')
    await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 503 })
  })

  it('preserves additive overrides and static-label routing', async () => {
    const { default: handler } = await import('~/server/api/internal/chain-policy.get')
    mocks.loadEulerChains.mockResolvedValue([{ chainId: 146, status: 'production' }])
    vi.stubEnv('DEPRECATED_CHAINS', '146')
    expect(await handler({} as never)).toMatchObject({ policy: { deprecated: true, onchain: false, metadataOnly: false } })
    vi.stubEnv('LABELS_SOURCE', 'static')
    expect(await handler({} as never)).toMatchObject({ policy: { deprecated: true, onchain: false, metadataOnly: false } })
    vi.stubEnv('ONCHAIN_SDK_CHAINS', '146')
    expect(await handler({} as never)).toMatchObject({ policy: { deprecated: true, onchain: true, metadataOnly: false } })
  })

  it('does not describe excluded chains or a missing registry as active', async () => {
    const { default: handler } = await import('~/server/api/internal/chain-policy.get')
    mocks.loadEulerChains.mockResolvedValue([{ chainId: 146, status: 'unlisted' }])
    await expect(handler({} as never)).rejects.toMatchObject({ statusCode: 400 })
    mocks.loadEulerChains.mockRejectedValue(new Error('registry unavailable'))
    await expect(handler({} as never)).rejects.toThrow('registry unavailable')
  })
})
