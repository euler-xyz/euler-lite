import { beforeEach, describe, expect, it, vi } from 'vitest'
import files from '~/tests/fixtures/static-labels.json'
import { KPK_VAULT, publicLabelsFixture } from '~/tests/fixtures/public-labels-v20260804151305236'
import { LiteEulerLabelsService } from '~/utils/sdk-labels'

const fetchMock = vi.fn()

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
