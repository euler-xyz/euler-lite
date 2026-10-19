import { describe, expect, it } from 'vitest'
import type { PublicEntityLabel } from '@eulerxyz/euler-v2-sdk/public-labels'
import type { EulerLabelEntity, EulerLabelProduct } from '~/entities/euler/labels'
import {
  getEulerLabelEntityDisplayName,
  getEulerLabelEntityKeys,
  getEulerLabelEntityId,
  getCuratorProfileCompleteness,
  getCuratorProfileExternalUrl,
  getCuratorProfilePath,
  getCuratorProfileSocialLinks,
  getCuratorProfileSocialUrl,
  isEulerLabelProductManagedBy,
  toCuratorProfileEntity,
} from '~/utils/curator-profile'

const entity = (name: string, logo = `${name}.svg`): EulerLabelEntity => ({
  name,
  logo,
  description: '',
  url: `https://${name.toLowerCase()}.example`,
  addresses: {},
  social: {
    twitter: '',
    youtube: '',
    discord: '',
    telegram: '',
    github: '',
  },
})

describe('curator profile helpers', () => {
  it('counts the description, website and six disclosures equally', () => {
    const completion = getCuratorProfileCompleteness({
      ...entity('K3'),
      description: 'Curator description',
    })

    expect(completion).toMatchObject({ provided: 2, total: 8, percentage: 25 })
    expect(completion.fields.filter(field => !field.value).map(field => field.label)).toEqual([
      'Legal entity', 'Risk methodology', 'Security', 'Terms of service', 'Licenses', 'Disclaimers',
    ])
  })

  it('does not give credit for whitespace, unsafe websites, branding or social links', () => {
    const completion = getCuratorProfileCompleteness({
      ...entity('K3'),
      description: ' \n ',
      url: 'javascript:alert(1)',
      legalEntityName: '  ',
      social: { ...entity('K3').social, twitter: 'https://x.com/k3_capital' },
    })

    expect(completion).toMatchObject({ provided: 0, total: 8, percentage: 0 })
    expect(completion.fields.every(field => !field.value)).toBe(true)
  })

  it('counts explicit non-applicability statements as provided information', () => {
    const completion = getCuratorProfileCompleteness({
      ...entity('K3'),
      description: ' Curator description ',
      legalEntityName: 'K3 Capital',
      riskMethodology: 'Published methodology',
      security: 'Security practices',
      termsOfService: 'https://k3.capital/terms',
      licenses: 'No licenses apply.',
      disclaimers: 'No additional disclaimers.',
    })

    expect(completion).toMatchObject({ provided: 8, total: 8, percentage: 100 })
    expect(completion.fields.find(field => field.key === 'description')?.value).toBe('Curator description')
  })

  it('converts one V3 entity record into profile details without a chain', () => {
    const profile = toCuratorProfileEntity({
      id: 'k3-capital',
      name: 'K3 Capital',
      logo: 'https://token-images.euler.finance/labels/k3-capital',
      description: 'Curator description',
      url: 'https://k3.capital',
      socialTwitter: 'https://x.com/k3_capital',
      socialGithub: 'javascript:alert(1)',
      riskMethodology: 'Published methodology',
    } as PublicEntityLabel)

    expect(profile).toMatchObject({
      id: 'k3-capital',
      name: 'K3 Capital',
      description: 'Curator description',
      riskMethodology: 'Published methodology',
      addresses: {},
      social: { twitter: 'https://x.com/k3_capital', github: '' },
    })
    expect(getCuratorProfileSocialLinks(profile)).toEqual([
      { label: 'Website', url: 'https://k3.capital/' },
      { label: 'X', url: 'https://x.com/k3_capital' },
    ])
  })

  it('normalizes product entity keys', () => {
    expect(getEulerLabelEntityKeys({ entity: 'k3' } as EulerLabelProduct)).toEqual(['k3'])
    expect(getEulerLabelEntityKeys({ entity: ['k3', 're7'] } as EulerLabelProduct)).toEqual(['k3', 're7'])
    expect(getEulerLabelEntityKeys({ entity: '' } as EulerLabelProduct)).toEqual([])
  })

  it('separates a V3 product owner from display-only co-brands', () => {
    const product = { entity: 'k3', coBrandEntityIds: ['re7'] } as EulerLabelProduct
    expect(isEulerLabelProductManagedBy(product, 'k3')).toBe(true)
    expect(isEulerLabelProductManagedBy(product, 're7')).toBe(false)

    // Static labels can still declare several managing entities.
    expect(isEulerLabelProductManagedBy({ entity: ['k3', 're7'] } as EulerLabelProduct, 're7')).toBe(true)
  })

  it('does not match unrelated product owners', () => {
    const product = { entity: ['k3', 're7'] } as EulerLabelProduct

    expect(isEulerLabelProductManagedBy(product, 're7')).toBe(true)
    expect(isEulerLabelProductManagedBy(product, 'mev-capital')).toBe(false)
  })

  it('uses a V3 entity ID or an exact static map entry', () => {
    const k3 = entity('K3')
    const entities = { k3, re7: entity('Re7') }

    expect(getEulerLabelEntityId(entities, k3)).toBe('k3')
    expect(getEulerLabelEntityId(entities, { ...k3 })).toBe('')
    expect(getEulerLabelEntityId(entities, { ...k3, id: 'k3' })).toBe('k3')
    expect(getEulerLabelEntityId(entities, { ...k3, id: 'unknown' })).toBe('')
  })

  it('formats compact curator labels', () => {
    expect(getEulerLabelEntityDisplayName([])).toBe('')
    expect(getEulerLabelEntityDisplayName([entity('K3')])).toBe('K3')
    expect(getEulerLabelEntityDisplayName([entity('K3'), entity('Re7')])).toBe('K3 & Re7')
    expect(getEulerLabelEntityDisplayName([entity('K3'), entity('Re7'), entity('MEV Capital')])).toBe('K3 & others')
  })

  it('builds curator profile paths', () => {
    expect(getCuratorProfilePath('mev-capital')).toBe('/curators/mev-capital')
    expect(getCuratorProfilePath('a/b')).toBe('/curators/a%2Fb')
  })

  it('normalizes curator social handles into external URLs', () => {
    expect(getCuratorProfileSocialUrl('twitter', '@k3_capital')).toBe('https://x.com/k3_capital')
    expect(getCuratorProfileSocialUrl('github', 'euler-xyz')).toBe('https://github.com/euler-xyz')
    expect(getCuratorProfileSocialUrl('telegram', 'https://t.me/UsualCommunity')).toBe('https://t.me/UsualCommunity')
    expect(getCuratorProfileSocialUrl('discord', 'hhttps://discord.usual.money/')).toBe('https://discord.usual.money/')
    expect(getCuratorProfileExternalUrl('example.com')).toBe('https://example.com/')
    expect(getCuratorProfileExternalUrl('http://example.com')).toBe('')
    expect(getCuratorProfileExternalUrl('javascript:alert(1)')).toBe('')
  })

  it('builds social links from entity metadata', () => {
    expect(getCuratorProfileSocialLinks({
      ...entity('K3'),
      url: 'k3.capital',
      social: {
        twitter: 'k3_capital',
        youtube: '',
        discord: '',
        telegram: '',
        github: 'k3-capital',
        legal: 'legal.k3.capital',
        defillama: 'https://defillama.com/protocol/k3',
      },
    })).toEqual([
      { label: 'Website', url: 'https://k3.capital/' },
      { label: 'X', url: 'https://x.com/k3_capital' },
      { label: 'GitHub', url: 'https://github.com/k3-capital' },
      { label: 'Legal', url: 'https://legal.k3.capital/' },
      { label: 'DefiLlama', url: 'https://defillama.com/protocol/k3' },
    ])
  })
})
