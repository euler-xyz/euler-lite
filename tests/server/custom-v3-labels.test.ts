import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { KPK_VAULT, PUBLIC_LABELS_FIXTURE_VERSION, publicLabelsFixture } from '~/tests/fixtures/public-labels-v20260804151305236'
import { normalizeLabelsBundle } from '~/utils/public-labels'

const manifest = vi.hoisted(() => [{ chainId: 1, status: 'production' }])
vi.mock('~/server/api/internal/euler-chains.get', () => ({
  loadEulerChains: async () => manifest,
  peekEulerChains: () => manifest,
}))

describe('custom V3 labels with real catalog selection', () => {
  let directory: string
  beforeEach(async () => {
    vi.resetModules()
    directory = await mkdtemp(join(tmpdir(), 'custom-v3-labels-'))
    for (const [key, value] of Object.entries({
      GEO_POLICY_CACHE_DIR: directory, V3_API_URL: 'https://custom-indexer.example.test',
      RPC_URL_1: 'https://rpc.example.test', DISABLE_V3: 'false', LABELS_SOURCE: 'v3',
      DEPRECATED_CHAINS: '', ONCHAIN_SDK_CHAINS: '', LABELS_V3_SET: '', LABELS_V3_VERSION: '',
      LABELS_VAULT_TAG: '', LABELS_IMAGE_ORIGINS: '',
      SERVER_VAULT_CACHE_SOURCE: 'fallback', NUXT_PUBLIC_BROWSER_VAULT_SOURCE: 'fallback',
    })) vi.stubEnv(key, value)
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    vi.unstubAllGlobals()
    await rm(directory, { recursive: true, force: true })
  })

  it('loads and caches full hosted visibility without requesting a chain catalog', async () => {
    const address = KPK_VAULT.toLowerCase()
    const visibility = publicLabelsFixture.visibility[address]
    const responses: Record<string, unknown> = {
      '/v3/geo-policies': [],
      '/v3/labels/sets/public/versions': [{ versionKey: PUBLIC_LABELS_FIXTURE_VERSION, status: 'published', isLatest: true }],
      '/v3/labels/vaults': [{ ...publicLabelsFixture.vaults[0], visibility }],
      '/v3/labels/products': publicLabelsFixture.products,
      '/v3/labels/entities': publicLabelsFixture.entities,
      ...Object.fromEntries(publicLabelsFixture.entities.flatMap(entity => [
        [`/v3/labels/entities/${entity.id}`, entity],
        [`/v3/labels/entities/${entity.id}/addresses`, publicLabelsFixture.entityAddresses.filter(row => row.entityId === entity.id)],
      ])),
    }
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input)
      expect(url.origin).toBe('https://custom-indexer.example.test')
      const data = responses[url.pathname]
      if (!data) return new Response('Not found', { status: 404 })
      if (url.pathname === '/v3/labels/vaults') expect(url.searchParams.get('include')).toBe('visibility')
      return Response.json({ data, meta: { total: Array.isArray(data) ? data.length : undefined, timestamp: new Date().toISOString() } })
    })
    vi.stubGlobal('fetch', fetch)
    const { getPublicLabelsBundle, getCachedPublicLabelsBundle } = await import('~/server/utils/public-labels-source')
    const active = await getPublicLabelsBundle(1)
    expect(active.chainPolicy).toEqual({ deprecated: false, onchain: false, metadataOnly: false })
    expect(normalizeLabelsBundle(1, active)).toMatchObject({
      source: 'v3', verifiedVaultAddresses: [KPK_VAULT], visibility: { [address]: visibility },
    })
    const requests = fetch.mock.calls.length
    vi.stubEnv('DEPRECATED_CHAINS', '1')
    vi.stubEnv('ONCHAIN_SDK_CHAINS', '1')
    const overridden = await getPublicLabelsBundle(1)
    expect(overridden).toMatchObject({ ...active, chainPolicy: { deprecated: true, onchain: true, metadataOnly: false } })
    expect(getCachedPublicLabelsBundle(1)).toEqual(overridden)
    expect(fetch).toHaveBeenCalledTimes(requests)
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname).sort()).toEqual(Object.keys(responses).sort())
  })

  it('loads static labels with V3 disabled without contacting the custom backend', async () => {
    vi.stubEnv('DISABLE_V3', 'true')
    vi.stubEnv('LABELS_SOURCE', 'static')
    vi.stubEnv('STATIC_LABELS_BASE_URL', 'https://labels.example.test')
    const fetch = vi.fn(async (input: string) => {
      const url = new URL(input)
      expect(url.origin).toBe('https://labels.example.test')
      return Response.json(/\/(products|entities)\.json$/.test(url.pathname) ? {} : [])
    })
    vi.stubGlobal('fetch', fetch)
    const { getPublicLabelsBundle } = await import('~/server/utils/public-labels-source')
    const bundle = await getPublicLabelsBundle(1)
    expect(bundle).toMatchObject({ source: 'static', chainPolicy: { deprecated: false, onchain: false, metadataOnly: false } })
    expect(await getPublicLabelsBundle(1)).toEqual(bundle)
    expect(fetch.mock.calls.map(([url]) => new URL(url).pathname).sort()).toEqual([
      '/1/assets.json', '/1/earn-vaults.json', '/1/entities.json', '/1/points.json', '/1/products.json', '/all/assets.json',
    ])
  })
})
