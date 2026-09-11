import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { H3Event } from 'h3'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), consume: vi.fn() }))
vi.mock('~/server/utils/fetchWithTimeout', () => ({ fetchWithTimeout: mocks.fetch }))
vi.mock('~/server/utils/rate-limit', () => ({ createRateLimiter: () => ({ consume: mocks.consume }) }))
vi.mock('~/server/utils/logger', () => ({ logger: { warn: vi.fn() } }))
vi.mock('h3', () => ({
  getMethod: (event: { method: string }) => event.method,
  getQuery: (event: { query: object }) => event.query,
  setResponseHeaders: vi.fn(), createError: (error: object) => Object.assign(new Error(), error),
}))
const event = (chainId: number, extra = '', method = 'GET') => ({ method, query: { chainId, extra } }) as unknown as H3Event
const response = () => ({ ok: true, json: async () => ({ data: [] }), text: async () => '{}' })

beforeEach(() => {
  vi.resetModules()
  vi.useFakeTimers()
  vi.setSystemTime(0)
  mocks.fetch.mockReset().mockImplementation(async () => response())
  mocks.consume.mockClear()
})
afterEach(() => vi.useRealTimers())

describe('intrinsic APY origin caching', () => {
  it.each([[999, 8], [143, 1]])('caches chain %i despite extra query parameters', async (chain, count) => {
    const { default: handler } = await import('~/server/api/internal/proxy/intrinsic-apy-overrides.get')
    await handler(event(chain, 'first'))
    await handler(event(chain, 'second'))
    expect(mocks.fetch).toHaveBeenCalledTimes(count)
    expect(mocks.consume).toHaveBeenCalledTimes(2)
    vi.setSystemTime(300_000)
    await handler(event(chain, 'third'))
    expect(mocks.fetch).toHaveBeenCalledTimes(count * 2)
  })

  it.each([[999, 8], [143, 1]])('coalesces concurrent chain %i requests', async (chain, count) => {
    let resolve!: () => void
    const gate = new Promise<void>((done) => {
      resolve = done
    })
    mocks.fetch.mockImplementation(async () => {
      await gate
      return response()
    })
    const { default: handler } = await import('~/server/api/internal/proxy/intrinsic-apy-overrides.get')
    const first = handler(event(chain, 'first'))
    const second = handler(event(chain, 'second'))
    await vi.waitFor(() => expect(mocks.fetch).toHaveBeenCalledTimes(count))
    resolve()
    await Promise.all([first, second])
    expect(mocks.fetch).toHaveBeenCalledTimes(count)
  })

  it('keeps chain caches separate and does not fetch for HEAD or unsupported chains', async () => {
    const { default: handler } = await import('~/server/api/internal/proxy/intrinsic-apy-overrides.get')
    await handler(event(999))
    await handler(event(143))
    expect(mocks.fetch).toHaveBeenCalledTimes(9)
    await handler(event(999, '', 'HEAD'))
    await handler(event(1))
    expect(mocks.fetch).toHaveBeenCalledTimes(9)
  })

  it('keeps nonempty results isolated across concurrent chains', async () => {
    mocks.fetch.mockImplementation(async () => ({
      ok: true, text: async () => '{}',
      json: async () => ({ data: [
        { pool: '88c6f0fd-5371-4b60-8032-ddf168b4bdd6', project: 'hyper', apy: 7 },
        { pool: '18147bfe-ee41-4762-9a95-c0ff28215798', project: 'monad', apy: 11 },
      ] }),
    }))
    const { default: handler } = await import('~/server/api/internal/proxy/intrinsic-apy-overrides.get')
    const [hyper, monad] = await Promise.all([handler(event(999)), handler(event(143))])
    expect(hyper).toEqual([expect.objectContaining({ chainId: 999, apy: 7 })])
    expect(monad).toEqual([expect.objectContaining({ chainId: 143, apy: 11 })])
    await expect(handler(event(999, 'cached'))).resolves.toEqual(hyper)
    await expect(handler(event(143, 'cached'))).resolves.toEqual(monad)
    expect(mocks.fetch).toHaveBeenCalledTimes(9)
  })

  it('caches HyperEVM all-source failure results until the origin TTL expires', async () => {
    mocks.fetch.mockRejectedValue(new Error('offline'))
    const { default: handler } = await import('~/server/api/internal/proxy/intrinsic-apy-overrides.get')
    await expect(handler(event(999))).resolves.toEqual([])
    await expect(handler(event(999, 'cached'))).resolves.toEqual([])
    expect(mocks.fetch).toHaveBeenCalledTimes(8)
    vi.setSystemTime(300_000)
    await expect(handler(event(999))).resolves.toEqual([])
    expect(mocks.fetch).toHaveBeenCalledTimes(16)
  })

  it('allows retry after an upstream rejection', async () => {
    mocks.fetch.mockRejectedValueOnce(new Error('offline'))
    const { default: handler } = await import('~/server/api/internal/proxy/intrinsic-apy-overrides.get')
    await expect(handler(event(143))).rejects.toThrow('offline')
    await expect(handler(event(143))).resolves.toEqual([])
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
  })
})
