import type { EulerLabelsData } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import { describe, expect, it, vi } from 'vitest'
import {
  fetchAllPublicLabelPages,
  fetchPublicLabelsData,
  getEulerLabelProductBrandEntities,
  getEulerLabelProductBrandEntityKeys,
  normalizePublicLabelsData,
  PUBLIC_LABELS_PAGE_SIZE,
  type PublicLabelsRequest,
  type PublicProductLabel,
} from '~/utils/public-labels'
import {
  ASSESSMENT_ONLY_EARN,
  ASSESSMENT_ONLY_EVK,
  KPK,
  KPK_GOVERNOR,
  KPK_VAULT,
  NEUTRAL_ESCROW,
  PUBLIC_LABELS_FIXTURE_VERSION,
  VERIFICATION_ONLY_EARN,
  VERIFICATION_ONLY_EVK,
  publicLabelsFixture,
} from '~/tests/fixtures/public-labels-v20260804151305236'

describe('Public Labels pagination', () => {
  it('follows meta.total with limit/offset using the pinned fixture version', async () => {
    const rows = Array.from({ length: 167 }, (_, index) => ({ id: `product-${index}` }))
    const request = vi.fn(async (_path: string, query: Record<string, string | number | undefined>) => {
      const offset = Number(query.offset)
      return {
        data: rows.slice(offset, offset + PUBLIC_LABELS_PAGE_SIZE),
        meta: {
          total: rows.length,
          offset,
          limit: PUBLIC_LABELS_PAGE_SIZE,
          timestamp: '2026-08-04T15:13:05.236Z',
        },
      }
    })

    const result = await fetchAllPublicLabelPages<Pick<PublicProductLabel, 'id'>>(
      request as PublicLabelsRequest,
      '/products',
      { version: PUBLIC_LABELS_FIXTURE_VERSION },
    )

    expect(result).toHaveLength(167)
    expect(request.mock.calls.map(([, query]) => query)).toEqual([
      { version: PUBLIC_LABELS_FIXTURE_VERSION, limit: 100, offset: 0 },
      { version: PUBLIC_LABELS_FIXTURE_VERSION, limit: 100, offset: 100 },
    ])
  })

  it('fails closed when pagination stops before meta.total', async () => {
    const request = vi.fn(async () => ({
      data: [],
      meta: { total: 1, timestamp: '2026-08-04T15:13:05.236Z' },
    })) as PublicLabelsRequest

    await expect(fetchAllPublicLabelPages(request, '/products', {
      version: PUBLIC_LABELS_FIXTURE_VERSION,
    })).rejects.toThrow('pagination stalled')
  })

  it('pins entity governance-address reads to the selected dataset version', async () => {
    const rowsByPath: Record<string, unknown[]> = {
      '/curation/vaults': publicLabelsFixture.vaults,
      '/products': publicLabelsFixture.products,
      '/entities': publicLabelsFixture.entities,
      '/geo-policies': publicLabelsFixture.geoPolicies,
      '/entities/kpk/addresses': publicLabelsFixture.entityAddresses,
      '/entities/securitize/addresses': [],
    }
    const request = vi.fn(async (path: string) => ({
      data: rowsByPath[path] ?? [],
      meta: {
        total: (rowsByPath[path] ?? []).length,
        timestamp: '2026-08-04T15:13:05.236Z',
      },
    })) as PublicLabelsRequest

    await fetchPublicLabelsData(request, 1, PUBLIC_LABELS_FIXTURE_VERSION)

    const addressCalls = vi.mocked(request).mock.calls.filter(([path]) => path.endsWith('/addresses'))
    expect(addressCalls).toHaveLength(2)
    expect(addressCalls.map(([, query]) => query)).toEqual([
      { chainId: 1, version: PUBLIC_LABELS_FIXTURE_VERSION, limit: 100, offset: 0 },
      { chainId: 1, version: PUBLIC_LABELS_FIXTURE_VERSION, limit: 100, offset: 0 },
    ])
  })
})

describe(`Public Labels ${PUBLIC_LABELS_FIXTURE_VERSION} normalization`, () => {
  it('keeps KPK as owner, exposes Securitize as a co-brand, and maps hosted profiles', () => {
    const legacy = {
      products: {
        'kpk-securitize': {
          name: 'Legacy KPK market',
          description: '',
          entity: KPK,
          url: '',
          vaults: [getAddress(KPK_VAULT)],
          block: ['US'],
          vaultOverrides: {
            [getAddress(KPK_VAULT)]: { restricted: ['CA'] },
          },
        },
      },
      assetBlocks: { '0xasset': ['GB'] },
      assetRestrictions: {},
      assetPatternRules: [],
      earnVaultBlocks: {},
      earnVaultRestrictions: {},
      earnVaultEntries: {},
      notExplorableEarnVaults: new Set<string>(),
    } as unknown as EulerLabelsData

    const result = normalizePublicLabelsData(1, publicLabelsFixture, legacy)
    const product = result.products['kpk-securitize']

    expect(product.entity).toBe(KPK)
    expect(product.coBrandEntityIds).toEqual(['securitize'])
    expect(getEulerLabelProductBrandEntityKeys(product)).toEqual([KPK, 'securitize'])
    expect(getEulerLabelProductBrandEntities(product, result.entities).map(entity => entity.id)).toEqual([
      KPK,
      'securitize',
    ])
    expect(product.vaults).toEqual([getAddress(KPK_VAULT)])
    expect(result.entities.kpk.logo).toBe('https://token-images.euler.finance/labels/kpk')
    expect(result.entities.kpk.addresses).toEqual({
      [getAddress(KPK_GOVERNOR)]: 'KPK Euler RWA Curation Safe',
    })
    expect(result.points[getAddress(KPK_VAULT)]).toEqual([{
      name: 'KPK RWA points',
      logo: 'https://token-images.euler.finance/labels/kpk',
      type: 'deposit',
    }])
  })

  it('keeps neutral escrows unattributed and raw geo policies non-effective', () => {
    const legacy = {
      products: {
        'kpk-securitize': {
          name: 'Legacy KPK market',
          description: '',
          entity: KPK,
          url: '',
          vaults: [getAddress(KPK_VAULT)],
          block: ['US'],
          vaultOverrides: {
            [getAddress(KPK_VAULT)]: { restricted: ['CA'] },
          },
        },
      },
      assetBlocks: {},
      assetRestrictions: {},
      assetPatternRules: [],
      earnVaultBlocks: {},
      earnVaultRestrictions: {},
      earnVaultEntries: {},
      notExplorableEarnVaults: new Set<string>(),
    } as unknown as EulerLabelsData

    const result = normalizePublicLabelsData(1, publicLabelsFixture, legacy)
    const product = result.products['kpk-securitize']

    expect(result.verifiedVaultAddresses).not.toContain(getAddress(NEUTRAL_ESCROW))
    expect(result.verifiedVaultAddresses).not.toContain(getAddress(ASSESSMENT_ONLY_EVK))
    expect(result.earnVaults).not.toContain(getAddress(ASSESSMENT_ONLY_EARN))
    expect(Object.keys(result.products)).not.toContain(`__vault_${NEUTRAL_ESCROW.toLowerCase()}`)
    expect(Object.keys(result.products)).not.toContain(`__vault_${ASSESSMENT_ONLY_EVK.toLowerCase()}`)
    expect(product.block).toEqual(['US'])
    expect(product.vaultOverrides?.[getAddress(KPK_VAULT)]?.restricted).toEqual(['CA'])
    expect(product.block).not.toContain('DE')
    expect(result.rawGeoPolicies).toEqual(publicLabelsFixture.geoPolicies)
  })

  it('retains compatibility-confirmed plain labels without trusting assessment-only rows', () => {
    const legacy = {
      products: {},
      verifiedVaultAddresses: [getAddress(VERIFICATION_ONLY_EVK)],
      earnVaults: [getAddress(VERIFICATION_ONLY_EARN)],
      assetBlocks: {},
      assetRestrictions: {},
      assetPatternRules: [],
      earnVaultBlocks: {},
      earnVaultRestrictions: {},
      earnVaultEntries: {},
      notExplorableEarnVaults: new Set<string>(),
    } as unknown as EulerLabelsData

    const result = normalizePublicLabelsData(1, publicLabelsFixture, legacy)

    expect(result.verifiedVaultAddresses).toContain(getAddress(VERIFICATION_ONLY_EVK))
    expect(result.verifiedVaultAddresses).not.toContain(getAddress(ASSESSMENT_ONLY_EVK))
    expect(result.earnVaults).toContain(getAddress(VERIFICATION_ONLY_EARN))
    expect(result.earnVaults).not.toContain(getAddress(ASSESSMENT_ONLY_EARN))
  })
})
