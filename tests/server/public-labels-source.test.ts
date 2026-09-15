import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getAddress } from 'viem'
import { KPK_VAULT, publicLabelsFixture } from '~/tests/fixtures/public-labels-v20260804151305236'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
  warn: vi.fn(),
}))

vi.mock('~/server/utils/fetchWithTimeout', async (importOriginal) => {
  const actual = await importOriginal<typeof import('~/server/utils/fetchWithTimeout')>()
  return {
    ...actual,
    fetchWithTimeout: mocks.fetchWithTimeout,
  }
})

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
    vi.stubEnv('LABELS_SOURCE', 'v3')
    vi.stubEnv('DEPRECATED_CHAINS', '')
    vi.stubEnv('LABELS_V3_SET', '')
    vi.stubEnv('LABELS_V3_VERSION', '')
    vi.stubEnv('V3_API_URL', 'https://v3.example.test')
    mocks.fetchWithTimeout.mockReset().mockImplementation(async (url: string) =>
      new URL(url).pathname.endsWith('/versions')
        ? versionsResponse()
        : emptyListResponse(),
    )
    mocks.warn.mockReset()
  })

  afterEach(async () => {
    await rm(directory, { recursive: true, force: true })
    vi.useRealTimers()
    vi.unstubAllEnvs()
  })

  it('selects metadata-only for deprecated chains, isolates its cache and never falls back after assessment failure', async () => {
    vi.stubEnv('RPC_URL_146', 'https://rpc.example.test')
    vi.stubEnv('ONCHAIN_SDK_CHAINS', '146')
    vi.stubEnv('DEPRECATED_CHAINS', '146')
    mocks.fetchWithTimeout.mockImplementation(async (input: string) => {
      const path = new URL(input).pathname
      if (path.startsWith('/v3/evk/') || path.startsWith('/v3/earn/')) return new Response('CHAIN_NOT_SUPPORTED', { status: 404 })
      return path.endsWith('/versions') ? versionsResponse() : emptyListResponse()
    })
    const { getPublicLabelsBundle } = await import('~/server/utils/public-labels-source')
    const bundle = await getPublicLabelsBundle(146)
    expect(bundle.source).toBe('v3-metadata')
    expect(bundle).not.toHaveProperty('publicLabels.visibility')
    expect(mocks.fetchWithTimeout.mock.calls.some(([url]) => /\/(evk|earn)\//.test(new URL(url).pathname))).toBe(false)
    vi.stubEnv('DEPRECATED_CHAINS', '')
    await expect(getPublicLabelsBundle(146)).rejects.toThrow('404')
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

  it('loads missing inventory verdicts through the SDK and retains them on refresh failure', async () => {
    const address = KPK_VAULT.toLowerCase()
    let failVisibility = false
    const json = (data: unknown, total?: number) => new Response(JSON.stringify({ data, meta: { total, timestamp: '2026-09-14T12:00:00Z' } }))
    mocks.fetchWithTimeout.mockImplementation(async (input: string) => {
      const url = new URL(input)
      const path = url.pathname
      if (path.endsWith('/versions')) return versionsResponse()
      if (path === '/v3/labels/vaults') return json([{ ...publicLabelsFixture.vaults[0], vaultType: 'securitize' }], 1)
      if (path === '/v3/labels/products') return json(publicLabelsFixture.products, publicLabelsFixture.products.length)
      if (path === '/v3/labels/entities') return json(publicLabelsFixture.entities, publicLabelsFixture.entities.length)
      if (path.startsWith('/v3/labels/entities/')) {
        const entityId = path.split('/')[4]
        if (path.endsWith('/addresses')) {
          const addresses = publicLabelsFixture.entityAddresses.filter(row => row.entityId === entityId)
          return json(addresses, addresses.length)
        }
        return json(publicLabelsFixture.entities.find(row => row.id === entityId))
      }
      if (path === `/v3/evk/vaults/1/${address}/visibility`) {
        expect(url.search).toBe('')
        if (failVisibility) return new Response('unavailable', { status: 503 })
        return json({ chainId: 1, vaultAddress: address, status: 'visible', checks: {
          decidedBy: 'verified', notExplorableLend: false,
          listing: { lend: { hidden: true }, borrow: { hidden: false } },
        } })
      }
      return emptyListResponse()
    })
    const { getPublicLabelsBundle, getPublicEulerLabelsData, refreshPublicLabelsBundle } = await import('~/server/utils/public-labels-source')
    const first = await getPublicLabelsBundle(1)
    const data = await getPublicEulerLabelsData(1)
    expect(data.verifiedVaultAddresses).toContain(getAddress(KPK_VAULT))
    expect(data.managingEntityByVault?.[address]).toBe('kpk')
    expect(data.visibility?.[address]).toMatchObject({ status: 'visible', explorableLend: false, explorableBorrow: true })
    failVisibility = true
    await expect(refreshPublicLabelsBundle(1)).resolves.toBe(first)
    vi.resetModules()
    const cold = await import('~/server/utils/public-labels-source')
    await expect(cold.getPublicLabelsBundle(1)).rejects.toThrow('503')
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

  it('uses configured set and version for server reads without resolving latest', async () => {
    vi.stubEnv('LABELS_V3_SET', 'test-instance')
    vi.stubEnv('LABELS_V3_VERSION', 'v20260804151305236')
    const { getPublicLabelsBundle } = await import('~/server/utils/public-labels-source')
    const bundle = await getPublicLabelsBundle(1)
    expect(bundle).toMatchObject({ labelSet: 'test-instance', version: 'v20260804151305236' })
    const urls = mocks.fetchWithTimeout.mock.calls.map(([url]) => new URL(url))
    expect(urls.some(url => url.pathname.endsWith('/versions'))).toBe(false)
    expect(urls.filter(url => url.pathname.startsWith('/v3/labels/')).every(url =>
      url.searchParams.get('labelSet') === 'test-instance' && url.searchParams.get('version') === 'v20260804151305236',
    )).toBe(true)
    expect(urls.filter(url => !url.pathname.startsWith('/v3/labels/')).every(url => !url.searchParams.has('labelSet'))).toBe(true)
  })

  it('separates cached and stale snapshots by set, version and upstream', async () => {
    const { getPublicLabelsBundle } = await import('~/server/utils/public-labels-source')
    const first = await getPublicLabelsBundle(1)
    vi.stubEnv('LABELS_V3_SET', 'test-instance')
    const other = await getPublicLabelsBundle(1)
    expect(other).not.toBe(first)
    expect(other).toMatchObject({ labelSet: 'test-instance' })
    expect(mocks.fetchWithTimeout.mock.calls.some(([url]) => new URL(url).pathname === '/v3/labels/sets/test-instance/versions')).toBe(true)
    vi.stubEnv('LABELS_V3_VERSION', 'v20260911011146353')
    const pinned = await getPublicLabelsBundle(1)
    expect(pinned).not.toBe(other)
    expect(pinned.version).toBe('v20260911011146353')
    mocks.fetchWithTimeout.mockRejectedValue(new Error('unavailable'))
    vi.stubEnv('LABELS_V3_SET', 'unavailable-set')
    await expect(getPublicLabelsBundle(1)).rejects.toThrow('unavailable')
    vi.stubEnv('LABELS_V3_SET', 'test-instance')
    vi.stubEnv('V3_API_URL', 'https://another-v3.test')
    await expect(getPublicLabelsBundle(1)).rejects.toThrow('unavailable')
  })

  it.each([
    ['LABELS_V3_SET', '../public'],
    ['LABELS_V3_VERSION', 'draft'],
  ])('rejects invalid %s before making requests', async (key, value) => {
    vi.stubEnv(key, value)
    const { getPublicLabelsBundle } = await import('~/server/utils/public-labels-source')
    expect(() => getPublicLabelsBundle(1)).toThrow(key)
    expect(mocks.fetchWithTimeout).not.toHaveBeenCalled()
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
  })
})
