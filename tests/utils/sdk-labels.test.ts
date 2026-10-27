import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { buildEulerSDK, type BuildQueryFn } from '@eulerxyz/euler-v2-sdk'
import files from '~/tests/fixtures/static-labels.json'
import { KPK_VAULT, publicLabelsFixture } from '~/tests/fixtures/public-labels-v20260804151305236'
import { LiteEulerLabelsService } from '~/utils/sdk-labels'

const fetchMock = vi.fn()

afterEach(() => vi.unstubAllGlobals())

describe('SDK labels source in Lite', () => {
  beforeEach(() => {
    fetchMock.mockReset()
    vi.stubGlobal('$fetch', fetchMock)
  })

  it('uses the hosted V3 snapshot through the same-origin endpoint', async () => {
    fetchMock.mockResolvedValue({
      source: 'v3',
      version: 'published',
      publicLabels: publicLabelsFixture,
      sourceFetchedAt: Date.now(),
    })

    const service = new LiteEulerLabelsService()
    const labels = await service.fetchEulerLabelsData(1)
    expect(fetchMock).toHaveBeenCalledWith('/api/internal/public-labels', {
      query: { chainId: 1 },
      timeout: 35_000,
    })
    expect(labels.verifiedVaultAddresses).toContain(KPK_VAULT)
    const vault = { chainId: 1, address: KPK_VAULT, populated: {} } as unknown as Parameters<typeof service.populateLabels>[0][number]
    await service.populateLabels([vault])
    expect(vault.eulerLabel?.products[0]?.id).toBe('kpk-securitize')
    expect(vault.populated.labels).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('uses a fork snapshot selected by the same server endpoint', async () => {
    fetchMock.mockResolvedValue({
      source: 'static',
      version: 'fork',
      files,
      logoBaseUrl: 'https://fork.test/labels',
      fetchedAt: Date.now(),
    })

    const labels = await new LiteEulerLabelsService().fetchEulerLabelsData(1)
    expect(labels.products.fork?.name).toBe('Fork product')
    expect(labels.entities.curator?.logo).toBe('https://fork.test/labels/logo/curator.svg')
  })

  it('accepts a server bundle loader for either configured source without a browser fetch', async () => {
    const loadBundle = vi.fn().mockResolvedValue({
      source: 'static',
      version: 'fork',
      files,
      logoBaseUrl: 'https://fork.test/labels',
      fetchedAt: Date.now(),
    })

    const labels = await new LiteEulerLabelsService(loadBundle).fetchEulerLabelsData(1)
    expect(loadBundle).toHaveBeenCalledWith(1)
    expect(labels.products.fork?.name).toBe('Fork product')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it.each([
    { source: 'v3', disableV3: false },
    { source: 'static', disableV3: false },
    { source: 'static', disableV3: true },
  ] as const)('keeps $source labels authoritative in the real SDK with disableV3=$disableV3', async ({ source, disableV3 }) => {
    const upstreamFetch = vi.fn(async () => {
      throw new Error('Unexpected SDK HTTP request')
    })
    vi.stubGlobal('fetch', upstreamFetch)
    const loadBundle = vi.fn().mockResolvedValue(source === 'v3'
      ? { source, version: 'published', publicLabels: publicLabelsFixture, sourceFetchedAt: Date.now() }
      : { source, version: 'fork', files, logoBaseUrl: 'https://fork.test/labels', fetchedAt: Date.now() })
    const service = new LiteEulerLabelsService(loadBundle)
    const buildQuery = ((name, fn) => name === 'queryDeployments' ? async () => [] : fn) as BuildQueryFn
    const sdk = await buildEulerSDK({
      config: { rpcUrls: {}, disableV3 },
      buildQuery,
      servicesOverrides: { eulerLabelsService: service },
    })

    expect(sdk.eulerLabelsService).toBe(service)
    const labels = await sdk.eulerLabelsService.fetchEulerLabelsData(1)
    if (source === 'v3') expect(labels.verifiedVaultAddresses).toContain(KPK_VAULT)
    else expect(labels.products.fork?.name).toBe('Fork product')
    expect(loadBundle).toHaveBeenCalledWith(1)

    loadBundle.mockRejectedValueOnce(new Error('Configured labels source unavailable'))
    await expect(sdk.eulerLabelsService.fetchEulerLabelsData(1)).rejects.toThrow('Configured labels source unavailable')
    expect(upstreamFetch).not.toHaveBeenCalled()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('rejects an expired hosted snapshot without reading file labels', async () => {
    fetchMock.mockResolvedValue({
      source: 'v3',
      version: 'published',
      publicLabels: publicLabelsFixture,
      sourceFetchedAt: Date.now() - 25 * 60 * 60_000,
    })

    const service = new LiteEulerLabelsService()
    await expect(service.fetchEulerLabelsData(1)).rejects.toThrow('Vault labels snapshot is too old')
    await expect(service.fetchEulerLabelsEntities(1)).rejects.toThrow('complete V3 or static snapshot')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })
})
