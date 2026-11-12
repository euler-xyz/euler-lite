import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), warn: vi.fn() }))
vi.mock('~/server/utils/fetchWithTimeout', async original => ({
  ...await original<typeof import('~/server/utils/fetchWithTimeout')>(),
  fetchWithTimeout: mocks.fetch,
}))
vi.mock('~/server/utils/logger', () => ({ logger: { warn: mocks.warn } }))

const catalog = (ids: number[]) => ({ data: ids.map(id => ({ id, capabilities: ['indexing', 'labels', 'assessments'] })) })

describe('V3 supported-chain catalog', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-12T12:00:00Z'))
    vi.stubEnv('V3_API_URL', 'https://v3.example.test')
    vi.stubEnv('V3_API_KEY', 'server-secret')
    vi.stubEnv('DISABLE_V3', 'false')
    vi.stubEnv('LABELS_SOURCE', 'v3')
    vi.stubEnv('SERVER_VAULT_CACHE_SOURCE', 'fallback')
    vi.stubEnv('NUXT_PUBLIC_BROWSER_VAULT_SOURCE', 'fallback')
    mocks.fetch.mockReset().mockImplementation(async () => Response.json(catalog([1, 999])))
    mocks.warn.mockReset()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.useRealTimers()
  })

  it('deduplicates requests and scopes the five-minute cache to upstream and credentials', async () => {
    const { loadV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
    const [first, joined] = await Promise.all([loadV3ChainCatalog(), loadV3ChainCatalog()])
    expect(first).toEqual({ indexedChainIds: [1, 999] })
    expect(joined).toBe(first)
    expect(await loadV3ChainCatalog()).toBe(first)
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('https://v3.example.test/v3/chains', 10_000, {
      headers: { 'accept': 'application/json', 'X-API-Key': 'server-secret' }, redirect: 'error',
    })
    vi.stubEnv('V3_API_URL', 'https://fork.example.test/v3/')
    mocks.fetch.mockResolvedValueOnce(Response.json(catalog([])))
    expect(await loadV3ChainCatalog()).toEqual({ indexedChainIds: [] })
    expect(mocks.fetch.mock.lastCall?.[0]).toBe('https://fork.example.test/v3/chains')
    vi.stubEnv('V3_API_KEY', 'different-secret')
    expect(await loadV3ChainCatalog()).toEqual({ indexedChainIds: [1, 999] })
    expect(mocks.fetch).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(first)).not.toContain('secret')
  })

  it('follows a complete retirement and reactivation without using health status as support', async () => {
    const { loadV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
    mocks.fetch.mockResolvedValueOnce(Response.json({ data: [{ id: 999, status: 'degraded', labeling: false, capabilities: ['indexing'] }] }))
    expect(await loadV3ChainCatalog()).toEqual({ indexedChainIds: [999] })
    vi.advanceTimersByTime(5 * 60_000)
    mocks.fetch.mockResolvedValueOnce(Response.json(catalog([])))
    expect(await loadV3ChainCatalog()).toEqual({ indexedChainIds: [] })
    vi.advanceTimersByTime(5 * 60_000)
    mocks.fetch.mockResolvedValueOnce(Response.json(catalog([999])))
    expect(await loadV3ChainCatalog()).toEqual({ indexedChainIds: [999] })
  })

  it('requires indexing capability for indexed routing', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ data: [{ id: 999, capabilities: ['labels'] }] }))
    const { loadV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
    expect(await loadV3ChainCatalog()).toEqual({ indexedChainIds: [] })
  })

  it.each([true, false])('preserves last-known indexed=%s during outages without renewing its age', async (indexed) => {
    const { loadV3ChainCatalog, peekV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
    mocks.fetch.mockResolvedValueOnce(Response.json(catalog(indexed ? [999] : [])))
    const first = await loadV3ChainCatalog()
    vi.advanceTimersByTime(5 * 60_000)
    mocks.fetch.mockImplementation(async () => new Response('unavailable', { status: 503 }))
    expect(await loadV3ChainCatalog()).toBe(first)
    expect(await loadV3ChainCatalog()).toBe(first)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(24 * 60 * 60_000)
    expect(peekV3ChainCatalog()).toBeUndefined()
    await expect(loadV3ChainCatalog()).rejects.toMatchObject({ statusCode: 503 })
    vi.advanceTimersByTime(30_000)
    mocks.fetch.mockResolvedValueOnce(Response.json(catalog(indexed ? [] : [999])))
    expect(await loadV3ChainCatalog()).toEqual({ indexedChainIds: indexed ? [] : [999] })
  })

  it.each([
    {}, { data: null }, { data: [{ id: 999 }] },
    { data: [{ id: '999', capabilities: ['indexing'] }] },
    { data: [{ id: 999, capabilities: [null] }] },
    { data: [...catalog([999]).data, ...catalog([999]).data] },
    { ...catalog([1]), meta: { total: 2 } },
    { ...catalog([1]), meta: { offset: 1 } },
    { ...catalog([1]), meta: { hasMore: true } },
    { ...catalog([1]), meta: { hasMore: 'true' } },
    { ...catalog([1]), meta: { nextCursor: 'next' } },
  ])('does not infer retirement from malformed or partial JSON: %j', async (payload) => {
    const { loadV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
    const first = await loadV3ChainCatalog()
    vi.advanceTimersByTime(5 * 60_000)
    mocks.fetch.mockResolvedValueOnce(Response.json(payload))
    expect(await loadV3ChainCatalog()).toBe(first)
  })

  it.each([401, 403, 404, 429, 500, 503])('reports unknown on a cold HTTP %s rather than an empty catalog', async (status) => {
    mocks.fetch.mockResolvedValueOnce(new Response('unavailable', { status }))
    const { loadV3ChainCatalog, peekV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
    await expect(loadV3ChainCatalog()).rejects.toMatchObject({ statusCode: 503 })
    expect(peekV3ChainCatalog()).toBeUndefined()
  })

  it('bounds response-body reads and prevents a late response from populating the cache', async () => {
    let finish!: (value: unknown) => void
    const body = new Promise((resolve) => {
      finish = resolve
    })
    mocks.fetch.mockResolvedValueOnce({ ok: true, json: () => body })
    const { loadV3ChainCatalog, peekV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
    const pending = expect(loadV3ChainCatalog()).rejects.toMatchObject({ statusCode: 503 })
    await vi.advanceTimersByTimeAsync(10_000)
    await pending
    vi.advanceTimersByTime(30_000)
    mocks.fetch.mockResolvedValueOnce(Response.json(catalog([])))
    expect(await loadV3ChainCatalog()).toEqual({ indexedChainIds: [] })
    finish(catalog([999]))
    await Promise.resolve()
    expect(peekV3ChainCatalog()).toEqual({ indexedChainIds: [] })
  })

  it('does not contact V3 for a deployment with V3 disabled', async () => {
    vi.stubEnv('DISABLE_V3', 'true')
    vi.stubEnv('LABELS_SOURCE', 'static')
    const { loadV3ChainCatalog, peekV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
    expect(await loadV3ChainCatalog()).toBeUndefined()
    expect(peekV3ChainCatalog()).toBeUndefined()
    expect(mocks.fetch).not.toHaveBeenCalled()
  })

  it.each(['fallback', 'SERVER_VAULT_CACHE_SOURCE', 'NUXT_PUBLIC_BROWSER_VAULT_SOURCE'])(
    'uses the catalog with static labels only when V3 data is selected: %s', async (setting) => {
      vi.stubEnv('LABELS_SOURCE', 'static')
      for (const key of ['V3_API_URL', 'EULER_SDK_V3_API_URL', 'NUXT_PUBLIC_V3_API_URL']) vi.stubEnv(key, '')
      if (setting !== 'fallback') vi.stubEnv(setting, 'v3')
      const { loadV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
      if (setting === 'fallback') {
        expect(await loadV3ChainCatalog()).toBeUndefined()
        expect(mocks.fetch).not.toHaveBeenCalled()
      }
      else {
        expect(await loadV3ChainCatalog()).toEqual({ indexedChainIds: [1, 999] })
        expect(mocks.fetch.mock.lastCall?.[0]).toBe('https://v3.euler.finance/v3/chains')
      }
    },
  )
})
