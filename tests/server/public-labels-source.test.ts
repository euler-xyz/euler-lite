import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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
  let directory: string
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'geo-bundle-test-'))
    vi.stubEnv('GEO_POLICY_CACHE_DIR', directory)
    vi.resetModules()
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-08-05T10:00:00Z'))
    vi.stubEnv('V3_API_URL', 'https://v3.example.test')
    mocks.fetchWithTimeout.mockReset().mockImplementation(async (url: string) =>
      new URL(url).pathname.endsWith('/labels/sets/public/versions')
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

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
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
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(7)
    expect(mocks.getEffectiveLabelsSource).toHaveBeenCalledTimes(1)
    expect(mocks.fetchWithTimeout.mock.calls.map(([url]) => new URL(url).pathname)).toEqual([
      '/v3/geo-policies',
      '/v3/labels/sets/public/versions',
      '/v3/labels/vaults',
      '/v3/labels/products',
      '/v3/labels/entities',
      '/v3/evk/vaults',
      '/v3/earn/vaults',
    ])
    expect(mocks.fetchWithTimeout.mock.calls.slice(2, 5).every(([url]) =>
      new URL(url).searchParams.get('version') === 'v20260804151305236',
    )).toBe(true)
  })

  it('uses deterministic fixture versions directly without resolving latest', async () => {
    const { getPublicLabelsBundle } = await import('~/server/utils/public-labels-source')

    const bundle = await getPublicLabelsBundle(1, 'v20260804151305236')

    expect(bundle.version).toBe('v20260804151305236')
    expect(mocks.fetchWithTimeout).toHaveBeenCalledTimes(6)
    expect(mocks.fetchWithTimeout.mock.calls.every(([url]) =>
      !new URL(url).pathname.endsWith('/labels/sets/public/versions'),
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

  it('does not publish a snapshot when geo is unavailable on a cold start', async () => {
    mocks.fetchWithTimeout.mockRejectedValue(new Error('geo unavailable'))
    const { getPublicLabelsBundle } = await import('~/server/utils/public-labels-source')
    await expect(getPublicLabelsBundle(1)).rejects.toThrow('geo unavailable')
    expect(mocks.getEffectiveLabelsSource).not.toHaveBeenCalled()
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
