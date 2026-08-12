import { getAddress } from 'viem'
import { describe, expect, it } from 'vitest'
import {
  getEulerLabelProductBrandEntities,
  getEulerLabelProductBrandEntityKeys,
} from '@eulerxyz/euler-v2-sdk/public-labels'
import {
  normalizePublicLabelsData,
  type EffectiveLabelsSource,
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

describe(`Public Labels ${PUBLIC_LABELS_FIXTURE_VERSION} normalization`, () => {
  it('keeps KPK as owner, exposes Securitize as a co-brand, and maps hosted profiles', () => {
    const effectivePolicy: EffectiveLabelsSource = {
      products: {
        'kpk-securitize': {
          vaults: [getAddress(KPK_VAULT)],
          block: ['US'],
          vaultOverrides: {
            [getAddress(KPK_VAULT)]: { restricted: ['CA'] },
          },
        },
      },
      earnVaults: [],
      assets: [],
    }

    const result = normalizePublicLabelsData(1, publicLabelsFixture, effectivePolicy)
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
    const effectivePolicy: EffectiveLabelsSource = {
      products: {
        'kpk-securitize': {
          vaults: [getAddress(KPK_VAULT)],
          block: ['US'],
          vaultOverrides: {
            [getAddress(KPK_VAULT)]: { restricted: ['CA'] },
          },
        },
      },
      earnVaults: [],
      assets: [],
    }

    const result = normalizePublicLabelsData(1, publicLabelsFixture, effectivePolicy)
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
    const effectivePolicy: EffectiveLabelsSource = {
      products: {
        compatibility: { vaults: [getAddress(VERIFICATION_ONLY_EVK)] },
      },
      earnVaults: [getAddress(VERIFICATION_ONLY_EARN)],
      assets: [],
    }

    const result = normalizePublicLabelsData(1, publicLabelsFixture, effectivePolicy)

    expect(result.verifiedVaultAddresses).toContain(getAddress(VERIFICATION_ONLY_EVK))
    expect(result.verifiedVaultAddresses).not.toContain(getAddress(ASSESSMENT_ONLY_EVK))
    expect(result.earnVaults).toContain(getAddress(VERIFICATION_ONLY_EARN))
    expect(result.earnVaults).not.toContain(getAddress(ASSESSMENT_ONLY_EARN))
  })

  it('keeps mixed vault tags scoped to their vault override', () => {
    const sibling = {
      ...publicLabelsFixture.vaults[0],
      address: '0x00000000000000000000000000000000000000C1',
      tags: [],
    }
    const result = normalizePublicLabelsData(1, {
      ...publicLabelsFixture,
      vaults: [publicLabelsFixture.vaults[0], sibling],
    })
    const product = result.products['kpk-securitize']

    expect(product.tags).toBeUndefined()
    expect(product.vaultOverrides?.[getAddress(KPK_VAULT)]?.tags).toContain('recently added')
    expect(product.vaultOverrides?.[getAddress(sibling.address)]?.tags).toBeUndefined()
  })

  it('drops non-http profile and campaign URLs at the normalization boundary', () => {
    const result = normalizePublicLabelsData(1, {
      ...publicLabelsFixture,
      entities: publicLabelsFixture.entities.map((entity, index) => index === 0
        ? { ...entity, logo: 'data:image/svg+xml,bad', url: 'javascript:alert(1)', socialTwitter: 'file:///tmp/bad' }
        : entity),
      vaults: publicLabelsFixture.vaults.map((vault, index) => index === 0
        ? { ...vault, campaigns: [{ name: 'Unsafe', logo: 'javascript:alert(1)', type: 'deposit' }] }
        : vault),
    })

    expect(result.entities.kpk.logo).toBe('')
    expect(result.entities.kpk.url).toBe('')
    expect(result.entities.kpk.social.twitter).toBe('')
    expect(result.points[getAddress(KPK_VAULT)]?.[0]?.logo).toBe('')
  })
})
