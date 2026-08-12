import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
  getEffectiveLabelsSource: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('~/server/utils/fetchWithTimeout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/fetchWithTimeout')>()
  return {
    ...actual,
    fetchWithTimeout: mocks.fetchWithTimeout,
  }
})

vi.mock('~/server/utils/labels-source', () => ({
  getEffectiveLabelsSource: mocks.getEffectiveLabelsSource,
}))

vi.mock('~/server/utils/logger', () => ({
  logger: { warn: mocks.warn },
}))

const emptyListResponse = () => new Response(JSON.stringify({
  data: [],
  meta: { total: 0, timestamp: '2026-08-04T15:13:05.236Z' },
}), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

const versionsResponse = () => new Response(JSON.stringify({
  data: [{
    versionKey: 'v20260804151305236',
    status: 'published',
    aliases: ['latest'],
    isLatest: true,
  }],
  meta: { timestamp: '2026-08-04T15:13:05.236Z' },
}), {
  status: 200,
  headers: { 'content-type': 'application/json' },
})

describe('public labels server source', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T10:00:00Z'))
    vi.stubEnv('V3_API_URL', 'https://v3.example.test')
    mocks.fetchWithTimeout.mockReset().mockImplementation(async (url: string) =>
      new URL(url).pathname.endsWith('/label-sets/public/versions')
        ? versionsResponse()
        : emptyListResponse(),
    )
    mocks.getEffectiveLabelsSource.mockReset().mockResolvedValue({
      products: {},
      earnVaults: [],
      assets: [],
    })
    mocks.warn.mockReset()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('deduplicates concurrent loads and serves the aggregate from cache', async () => {
    const { getPublicLabelsBundle } = await import('~/server/utils/public-labels-source')

    const [first, concurrent] = await Promise.all([
      getPublicLabelsBundle(1),
      getPublicLabelsBundle(1),
    ])
    const cached = await getPublicLabelsBundle(1)

    expect(concurrent).toBe(first)
    expect(cached).toBe(first)
    expect(first.version).toBe('v20260804151305236')
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(5)
    expect(mocks.getEffectiveLabelsSource).toHaveBeenCalledTimes(1)
    expect(mocks.fetchWithTimeout.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/v3/label-sets/public/versions',
      '/v3/curation/vaults',
      '/v3/products',
      '/v3/entities',
      '/v3/geo-policies',
    ])
    expect(mocks.fetchWithTimeout.mock.calls.slice(1).every(([url]) =>
      new URL(url).searchParams.get('version') === 'v20260804151305236',
    )).toBe(true)
  })

  it('uses deterministic fixture versions directly without resolving latest', async () => {
    const { getPublicLabelsBundle } = await import('~/server/utils/public-labels-source')

    const bundle = await getPublicLabelsBundle(1, 'v20260804151305236')

    expect(bundle.version).toBe('v20260804151305236')
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(4)
    expect(mocks.fetchWithTimeout.mock.calls.every(([url]) =>
      !new URL(url).pathname.endsWith('/label-sets/public/versions'),
    )).toBe(true)
  })

  it('serves a bounded stale bundle when a refresh fails', async () => {
    const { getPublicLabelsBundle } = await import('~/server/utils/public-labels-source')
    const first = await getPublicLabelsBundle(1)

    vi.advanceTimersByTime(300_001)
    mocks.fetchWithTimeout.mockRejectedValue(new Error('V3 unavailable'))

    await expect(getPublicLabelsBundle(1)).resolves.toBe(first)
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ctx: 'public-labels-source', chainId: 1 }),
      'refresh failed',
    )
  })

  it('fails closed when effective policy is unavailable without stale data', async () => {
    mocks.getEffectiveLabelsSource.mockRejectedValue(new Error('policy unavailable'))
    const { getPublicLabelsBundle } = await import('~/server/utils/public-labels-source')

    await expect(getPublicLabelsBundle(1)).rejects.toThrow('policy unavailable')
    expect(mocks.warn).toHaveBeenCalledWith(
      expect.objectContaining({ ctx: 'public-labels-source', chainId: 1 }),
      'refresh failed',
    )
  })
})
