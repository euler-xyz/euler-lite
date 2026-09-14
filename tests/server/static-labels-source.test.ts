import { mkdtemp, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest'
import files from '~/tests/fixtures/static-labels.json'
import { normalizeLabelsBundle } from '~/utils/public-labels'

const fetchMock = vi.hoisted(() => vi.fn())
vi.mock('~/server/utils/fetchWithTimeout', async original => ({ ...await original<typeof import('~/server/utils/fetchWithTimeout')>(), fetchWithTimeout: fetchMock }))
vi.mock('~/server/utils/logger', () => ({ logger: { warn: vi.fn() } }))

describe('static authoring source', () => {
  let directory: string
  beforeEach(async () => {
    vi.resetModules()
    directory = await mkdtemp(join(tmpdir(), 'static-labels-'))
    vi.stubEnv('GEO_POLICY_CACHE_DIR', directory)
    vi.stubEnv('STATIC_LABELS_BASE_URL', 'https://fork.test/labels')
    vi.stubEnv('LABELS_SOURCE', 'static')
    vi.stubEnv('LABELS_V3_SET', '../ignored-in-static-mode')
    vi.stubEnv('LABELS_V3_VERSION', 'draft')
    fetchMock.mockReset().mockImplementation(async (url: string) => {
      const filename = url.split('/').pop()
      const key = filename === 'earn-vaults.json' ? 'earnVaults' : filename?.replace('.json', '')
      return Response.json(url.includes('/all/') ? [{ nameRegex: '^ond[o]', restricted: ['EEA'] }] : files[key as keyof typeof files])
    })
  })
  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(directory, { recursive: true, force: true })
  })
  it('feeds authored membership, governance, points, logos, explorability and geo into the same snapshot without V3', async () => {
    const { getPublicLabelsBundle } = await import('~/server/utils/public-labels-source')
    const raw = await getPublicLabelsBundle(1)
    const data = normalizeLabelsBundle(1, raw)
    expect(fetchMock).toHaveBeenCalledTimes(6)
    expect(fetchMock.mock.calls.every(([url]) => url.startsWith('https://fork.test/labels/'))).toBe(true)
    expect(data.visibility).toBeUndefined()
    expect(data.geoContext).toBeUndefined()
    expect(data.verifiedVaultAddresses).toEqual(['0x' + '1'.repeat(40)])
    expect(data.earnVaults).toEqual(['0x' + '2'.repeat(40)])
    expect(data.products.fork).toMatchObject({ entity: 'curator', block: ['US'], vaultOverrides: { ['0x' + '1'.repeat(40)]: { restricted: ['CA'], notExplorableBorrow: true } } })
    expect(data.entities.curator.addresses).toEqual({ ['0x' + '3'.repeat(40)]: 'Owner' })
    expect(data.entities.curator.logo).toBe('https://fork.test/labels/logo/curator.svg')
    expect(data.points['0x' + '1'.repeat(40)]?.[0]).toMatchObject({ name: 'Fork points', logo: 'https://fork.test/labels/logo/points.svg' })
    expect(data.assetBlocks).toEqual({ ['0x' + '4'.repeat(40)]: ['US'] })
    expect(data.assetPatternRules[0]?.nameRegex?.test('ondo')).toBe(true)
    expect(data.earnVaultRestrictions).toEqual({ ['0x' + '2'.repeat(40)]: ['GB'] })
  })
  it.each([403, 404])('accepts omitted files with HTTP %s while preserving global asset rules', async (status) => {
    const defaultFetch = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/1/assets.json') || url.endsWith('/1/earn-vaults.json')
      ? new Response(null, { status })
      : defaultFetch(url))
    const { getStaticLabelsBundle } = await import('~/server/utils/static-labels-source')
    const raw = await getStaticLabelsBundle(1)
    const data = normalizeLabelsBundle(1, raw)
    expect(raw.files.assets).toEqual([{ nameRegex: '^ond[o]', restricted: ['EEA'] }])
    expect(data.verifiedVaultAddresses).toEqual(['0x' + '1'.repeat(40)])
    expect(data.earnVaults).toEqual([])
    expect(data.assetPatternRules[0]?.nameRegex?.test('ondo')).toBe(true)
    expect(data.products.fork.block).toEqual(['US'])
  })
  it('preserves chain asset rules when the global file is omitted', async () => {
    const defaultFetch = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string) => url.endsWith('/all/assets.json')
      ? new Response(null, { status: 404 })
      : defaultFetch(url))
    const { getStaticLabelsBundle } = await import('~/server/utils/static-labels-source')
    const raw = await getStaticLabelsBundle(1)
    expect(raw.files.assets).toEqual(files.assets)
    expect(normalizeLabelsBundle(1, raw).assetBlocks).toEqual({ ['0x' + '4'.repeat(40)]: ['US'] })
  })
  it.each([403, 404])('uses the correct empty shapes when all files return HTTP %s', async (status) => {
    fetchMock.mockImplementation(async () => new Response(null, { status }))
    const { getStaticLabelsBundle } = await import('~/server/utils/static-labels-source')
    const raw = await getStaticLabelsBundle(1)
    expect(raw.files).toEqual({ products: {}, entities: {}, points: [], earnVaults: [], assets: [] })
    expect(normalizeLabelsBundle(1, raw).verifiedVaultAddresses).toEqual([])
  })
  it.each([401, 429, 500, 503])('fails cold on HTTP %s instead of treating it as an omitted file', async (status) => {
    fetchMock.mockImplementation(async () => new Response(null, { status }))
    const { getStaticLabelsBundle } = await import('~/server/utils/static-labels-source')
    await expect(getStaticLabelsBundle(1)).rejects.toThrow(`HTTP ${status}`)
  })
  it.each(['network', 'json', 'server'])('retains the whole snapshot when one asset file has a %s failure', async (failure) => {
    const { getStaticLabelsBundle } = await import('~/server/utils/static-labels-source')
    const first = await getStaticLabelsBundle(1)
    const defaultFetch = fetchMock.getMockImplementation()!
    fetchMock.mockImplementation(async (url: string) => {
      if (!url.endsWith('/all/assets.json')) return defaultFetch(url)
      if (failure === 'network') throw new Error('offline')
      return failure === 'json' ? new Response('{') : new Response(null, { status: 503 })
    })
    expect(await getStaticLabelsBundle(1, true)).toEqual(first)
  })
  it('rejects malformed geo fields instead of silently dropping restrictions', async () => {
    fetchMock.mockImplementation(async (url: string) => Response.json(url.endsWith('/assets.json') ? [{ nameRegex: 42, block: ['US'] }] : url.endsWith('/products.json') || url.endsWith('/entities.json') ? {} : []))
    const { getStaticLabelsBundle } = await import('~/server/utils/static-labels-source')
    await expect(getStaticLabelsBundle(1)).rejects.toThrow('Invalid static nameRegex')
  })
  it('retains the entire checkpoint after restart when any file fails', async () => {
    const { getStaticLabelsBundle } = await import('~/server/utils/static-labels-source')
    const first = await getStaticLabelsBundle(1)
    vi.resetModules()
    fetchMock.mockRejectedValue(new Error('offline'))
    const restarted = await import('~/server/utils/static-labels-source')
    expect(await restarted.getStaticLabelsBundle(1)).toEqual(first)
  })
})
