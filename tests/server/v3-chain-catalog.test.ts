import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ fetch: vi.fn(), warn: vi.fn() }))
vi.mock('~/server/utils/logger', () => ({ logger: { warn: mocks.warn, info: vi.fn() } }))

const catalog = (ids: number[]) => ({ data: ids.map(id => ({ id, capabilities: ['indexing', 'labels', 'assessments'] })) })

describe('V3 supported-chain catalog', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-12T12:00:00Z'))
    vi.stubEnv('V3_API_URL', 'https://v3.euler.finance')
    vi.stubEnv('V3_API_KEY', 'server-secret')
    vi.stubEnv('DISABLE_V3', 'false')
    vi.stubEnv('LABELS_SOURCE', 'v3')
    vi.stubEnv('SERVER_VAULT_CACHE_SOURCE', 'fallback')
    vi.stubEnv('NUXT_PUBLIC_BROWSER_VAULT_SOURCE', 'fallback')
    mocks.fetch.mockReset().mockImplementation(async () => Response.json(catalog([1, 999])))
    vi.stubGlobal('fetch', mocks.fetch)
    mocks.warn.mockReset()
  })
  afterEach(() => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })

  it('deduplicates requests and scopes the five-minute cache to credentials', async () => {
    const { loadV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
    const [first, joined] = await Promise.all([loadV3ChainCatalog(), loadV3ChainCatalog()])
    expect(first).toEqual({ indexedChainIds: [1, 999] })
    expect(joined).toBe(first)
    expect(await loadV3ChainCatalog()).toBe(first)
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith('https://v3.euler.finance/v3/chains', {
      signal: expect.any(AbortSignal),
      headers: { 'accept': 'application/json', 'X-API-Key': 'server-secret' }, redirect: 'error',
    })
    vi.stubEnv('V3_API_KEY', 'different-secret')
    expect(await loadV3ChainCatalog()).toEqual({ indexedChainIds: [1, 999] })
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(JSON.stringify(first)).not.toContain('secret')
  })

  it.each([
    ['', 'https://v3.euler.finance'],
    ['https://v3.euler.finance/', 'https://v3.euler.finance'],
    ['https://V3.EULER.FINANCE:443/', 'https://v3.euler.finance'],
    ['https://catalog-fixture.euler.finance', 'https://catalog-fixture.euler.finance'],
    ['https://CATALOG-FIXTURE.EULER.FINANCE:443/', 'https://catalog-fixture.euler.finance'],
    ['https://nested.catalog-fixture.euler.finance/', 'https://nested.catalog-fixture.euler.finance'],
  ])(
    'loads the configured Euler subdomain catalog after URL normalization: %s', async (url, origin) => {
      for (const key of ['V3_API_URL', 'EULER_SDK_V3_API_URL', 'NUXT_PUBLIC_V3_API_URL']) vi.stubEnv(key, '')
      vi.stubEnv('V3_API_URL', url)
      const { requiresV3ChainCatalog, loadV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
      expect(requiresV3ChainCatalog()).toBe(true)
      expect(await loadV3ChainCatalog()).toEqual({ indexedChainIds: [1, 999] })
      expect(mocks.fetch.mock.lastCall?.[0]).toBe(`${origin}/v3/chains`)
    },
  )

  it.each(['V3_API_URL', 'EULER_SDK_V3_API_URL', 'NUXT_PUBLIC_V3_API_URL'])(
    'uses the existing %s alias to select Euler or custom routing', async (key) => {
      for (const alias of ['V3_API_URL', 'EULER_SDK_V3_API_URL', 'NUXT_PUBLIC_V3_API_URL']) vi.stubEnv(alias, '')
      const { requiresV3ChainCatalog, loadV3ChainCatalog, peekV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
      vi.stubEnv(key, 'https://v3.euler.finance')
      await loadV3ChainCatalog()
      vi.stubEnv(key, 'https://catalog-fixture.euler.finance')
      expect(peekV3ChainCatalog()).toBeUndefined()
      expect(await loadV3ChainCatalog()).toEqual({ indexedChainIds: [1, 999] })
      expect(mocks.fetch.mock.lastCall?.[0]).toBe('https://catalog-fixture.euler.finance/v3/chains')
      vi.stubEnv(key, 'https://indexer.example.test')
      expect(requiresV3ChainCatalog()).toBe(false)
      expect(peekV3ChainCatalog()).toBeUndefined()
      expect(await loadV3ChainCatalog()).toBeUndefined()
      expect(mocks.fetch).toHaveBeenCalledTimes(2)
    },
  )

  it.each(['v3.operator.example', 'https://[invalid'])('leaves malformed URL validation to the labels configuration: %s', async (url) => {
    vi.stubEnv('V3_API_URL', url)
    const { requiresV3ChainCatalog, peekV3ChainCatalog, loadV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
    const { readV3LabelsSelection } = await import('~/server/utils/labels-base-url')
    expect(requiresV3ChainCatalog()).toBe(false)
    expect(peekV3ChainCatalog()).toBeUndefined()
    await expect(loadV3ChainCatalog()).resolves.toBeUndefined()
    expect(mocks.fetch).not.toHaveBeenCalled()
    expect(readV3LabelsSelection).toThrow('V3_API_URL must be an HTTP(S) directory URL without credentials, query or fragment')
  })

  it.each([
    'https://indexer.example.test', 'https://v3.euler.finance.example.test',
    'https://not-euler.finance', 'https://euler.finance',
    'https://v3.euler.finance:8443', 'http://v3.euler.finance',
    'https://v3.euler.finance/custom', 'https://proxy.example.test/v3',
    'https://catalog-fixture.euler.finance:8443', 'http://catalog-fixture.euler.finance',
    'https://catalog-fixture.euler.finance/v3',
    'https://user:secret@catalog-fixture.euler.finance',
    'https://catalog-fixture.euler.finance?query=1', 'https://catalog-fixture.euler.finance#fragment',
  ])('does not probe or use Euler cached support for a custom base URL: %s', async (url) => {
    const { loadV3ChainCatalog, refreshV3ChainCatalog, peekV3ChainCatalog, requiresV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
    mocks.fetch.mockResolvedValueOnce(Response.json(catalog([])))
    await loadV3ChainCatalog()
    vi.stubEnv('V3_API_URL', url)
    vi.stubEnv('EULER_SDK_V3_API_URL', 'https://v3.euler.finance')
    mocks.fetch.mockRejectedValue(new Error('Custom indexer has no catalog'))
    expect(requiresV3ChainCatalog()).toBe(false)
    expect(await loadV3ChainCatalog()).toBeUndefined()
    expect(await refreshV3ChainCatalog()).toBeUndefined()
    expect(peekV3ChainCatalog()).toBeUndefined()
    expect(mocks.fetch).toHaveBeenCalledOnce()
    vi.stubEnv('V3_API_URL', 'https://v3.euler.finance')
    expect(await loadV3ChainCatalog()).toEqual({ indexedChainIds: [] })
  })

  it.each([
    ['https://catalog-fixture.euler.finance', 'server-secret', true],
    ['https://v3.euler.finance', 'different-secret', true],
    ['https://indexer.example.test', 'server-secret', false],
  ] as const)('isolates a pending refresh from a newly selected source: %s (%s)', async (url, apiKey, needsCatalog) => {
    const { loadV3ChainCatalog, refreshV3ChainCatalog, peekV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
    const first = await loadV3ChainCatalog()
    vi.advanceTimersByTime(5 * 60_000)
    let finish!: (response: Response) => void
    mocks.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      finish = resolve
    }))
    expect(await loadV3ChainCatalog()).toBe(first)
    const oldRefresh = refreshV3ChainCatalog()

    vi.stubEnv('V3_API_URL', url)
    vi.stubEnv('V3_API_KEY', apiKey)
    expect(peekV3ChainCatalog()).toBeUndefined()
    mocks.fetch.mockResolvedValueOnce(Response.json(catalog([])))
    const expected = needsCatalog ? { indexedChainIds: [] } : undefined
    expect(await loadV3ChainCatalog()).toEqual(expected)
    if (needsCatalog) {
      expect(mocks.fetch.mock.lastCall).toEqual([`${url}/v3/chains`, expect.objectContaining({
        headers: { 'accept': 'application/json', 'X-API-Key': apiKey },
      })])
    }

    finish(Response.json(catalog([999])))
    await oldRefresh
    expect(peekV3ChainCatalog()).toEqual(expected)
    expect(await loadV3ChainCatalog()).toEqual(expected)
    expect(mocks.fetch).toHaveBeenCalledTimes(needsCatalog ? 3 : 2)
  })

  it('serves stale immediately while one background refresh retires or reactivates a chain', async () => {
    const { loadV3ChainCatalog, refreshV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
    mocks.fetch.mockResolvedValueOnce(Response.json({ data: [{ id: 999, status: 'degraded', labeling: false, capabilities: ['indexing'] }] }))
    let current = await loadV3ChainCatalog()
    expect(current).toEqual({ indexedChainIds: [999] })
    for (const ids of [[], [999]]) {
      vi.advanceTimersByTime(5 * 60_000)
      let finish!: (response: Response) => void
      mocks.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => {
        finish = resolve
      }))
      const calls = mocks.fetch.mock.calls.length
      const startedAt = Date.now()
      expect(await Promise.all([loadV3ChainCatalog(), loadV3ChainCatalog(), loadV3ChainCatalog()])).toEqual([current, current, current])
      expect(Date.now()).toBe(startedAt)
      expect(mocks.fetch).toHaveBeenCalledTimes(calls + 1)
      const refreshed = refreshV3ChainCatalog()
      finish(Response.json(catalog(ids)))
      current = await refreshed
      expect(await loadV3ChainCatalog()).toEqual({ indexedChainIds: ids })
      expect(mocks.fetch).toHaveBeenCalledTimes(calls + 1)
    }
  })

  it('forces periodic refresh before expiry while reads retain the fresh copy', async () => {
    const { loadV3ChainCatalog, refreshV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
    const first = await loadV3ChainCatalog()
    vi.advanceTimersByTime(5 * 60_000 - 1)
    let finish!: (response: Response) => void
    mocks.fetch.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      finish = resolve
    }))
    const refresh = refreshV3ChainCatalog()
    expect(await loadV3ChainCatalog()).toBe(first)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    finish(Response.json(catalog([])))
    await refresh
    expect(await loadV3ChainCatalog()).toEqual({ indexedChainIds: [] })
  })

  it('requires indexing capability for indexed routing', async () => {
    mocks.fetch.mockResolvedValueOnce(Response.json({ data: [{ id: 999, capabilities: ['labels'] }] }))
    const { loadV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
    expect(await loadV3ChainCatalog()).toEqual({ indexedChainIds: [] })
  })

  it.each([true, false])('preserves last-known indexed=%s during outages without renewing its age', async (indexed) => {
    const { loadV3ChainCatalog, refreshV3ChainCatalog, peekV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
    mocks.fetch.mockResolvedValueOnce(Response.json(catalog(indexed ? [999] : [])))
    const first = await loadV3ChainCatalog()
    vi.advanceTimersByTime(5 * 60_000)
    mocks.fetch.mockImplementation(async () => new Response('unavailable', { status: 503 }))
    expect(await loadV3ChainCatalog()).toBe(first)
    expect(await loadV3ChainCatalog()).toBe(first)
    expect(await refreshV3ChainCatalog()).toBe(first)
    expect(await refreshV3ChainCatalog()).toBe(first)
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    vi.advanceTimersByTime(24 * 60 * 60_000)
    expect(peekV3ChainCatalog()).toBeUndefined()
    await expect(loadV3ChainCatalog()).rejects.toMatchObject({ statusCode: 503 })
    vi.advanceTimersByTime(30_000)
    mocks.fetch.mockResolvedValueOnce(Response.json(catalog(indexed ? [] : [999])))
    expect(await loadV3ChainCatalog()).toEqual({ indexedChainIds: indexed ? [] : [999] })
  })

  it('stops serving a last-good copy that expires during a background refresh', async () => {
    const { loadV3ChainCatalog, peekV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
    const first = await loadV3ChainCatalog()
    vi.advanceTimersByTime(24 * 60 * 60_000 - 1_000)
    mocks.fetch.mockImplementationOnce(() => new Promise<Response>(() => {}))
    expect(await loadV3ChainCatalog()).toBe(first)
    await vi.advanceTimersByTimeAsync(1_001)
    expect(peekV3ChainCatalog()).toBeUndefined()
    const expired = expect(loadV3ChainCatalog()).rejects.toMatchObject({ statusCode: 503 })
    await vi.advanceTimersByTimeAsync(8_999)
    await expired
    expect(mocks.fetch).toHaveBeenCalledTimes(2)
    expect(mocks.fetch.mock.calls[1][1].signal.aborted).toBe(true)
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
    const { loadV3ChainCatalog, refreshV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
    const first = await loadV3ChainCatalog()
    vi.advanceTimersByTime(5 * 60_000)
    mocks.fetch.mockResolvedValueOnce(Response.json(payload))
    expect(await loadV3ChainCatalog()).toBe(first)
    expect(await refreshV3ChainCatalog()).toBe(first)
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
    expect(mocks.fetch.mock.calls[0][1].signal.aborted).toBe(true)
    vi.advanceTimersByTime(30_000)
    mocks.fetch.mockResolvedValueOnce(Response.json(catalog([])))
    expect(await loadV3ChainCatalog()).toEqual({ indexedChainIds: [] })
    finish(catalog([999]))
    await Promise.resolve()
    expect(peekV3ChainCatalog()).toEqual({ indexedChainIds: [] })
  })

  it.each([false, true])('cancels a stalled body and releases the request with a cached policy=%s', async (warm) => {
    const { loadV3ChainCatalog, peekV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
    if (warm) {
      await loadV3ChainCatalog()
      vi.advanceTimersByTime(5 * 60_000)
    }
    const cancel = vi.fn()
    mocks.fetch.mockImplementationOnce(async (_url, { signal }: RequestInit) => {
      const stream = new ReadableStream({
        start(controller) {
          signal!.addEventListener('abort', () => {
            cancel()
            controller.error(new DOMException('Aborted', 'AbortError'))
          }, { once: true })
          controller.enqueue(new TextEncoder().encode('{"data":['))
        },
      })
      return new Response(stream)
    })
    const pending = loadV3ChainCatalog()
    const outcome = warm
      ? expect(pending).resolves.toEqual({ indexedChainIds: [1, 999] })
      : expect(pending).rejects.toMatchObject({ statusCode: 503 })
    if (warm) await outcome
    await vi.advanceTimersByTimeAsync(9_999)
    expect(cancel).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    await outcome
    expect(cancel).toHaveBeenCalledOnce()
    expect(peekV3ChainCatalog()).toEqual(warm ? { indexedChainIds: [1, 999] } : undefined)
    vi.advanceTimersByTime(30_000)
    expect(await loadV3ChainCatalog()).toEqual({ indexedChainIds: [1, 999] })
    await vi.advanceTimersByTimeAsync(0)
  })

  it('does not contact V3 for a deployment with V3 disabled', async () => {
    vi.stubEnv('DISABLE_V3', 'true')
    vi.stubEnv('LABELS_SOURCE', 'static')
    const { loadV3ChainCatalog, refreshV3ChainCatalog, peekV3ChainCatalog } = await import('~/server/utils/v3-chain-catalog')
    expect(await loadV3ChainCatalog()).toBeUndefined()
    expect(await refreshV3ChainCatalog()).toBeUndefined()
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
