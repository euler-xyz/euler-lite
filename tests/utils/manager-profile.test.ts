import { describe, expect, it } from 'vitest'
import type { EulerLabelEntity, EulerLabelProduct } from '~/entities/euler/labels'
import {
  getEulerLabelEntityDisplayName,
  getEulerLabelEntityKeys,
  getEulerLabelEntitySlug,
  getManagerProfileExternalUrl,
  getManagerProfilePath,
  getManagerProfileSocialLinks,
  getManagerProfileSocialUrl,
  isEulerLabelProductManagedBy,
} from '~/utils/manager-profile'

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

describe('manager profile helpers', () => {
  it('normalizes product entity keys', () => {
    expect(getEulerLabelEntityKeys({ entity: 'k3' } as EulerLabelProduct)).toEqual(['k3'])
    expect(getEulerLabelEntityKeys({ entity: ['k3', 're7'] } as EulerLabelProduct)).toEqual(['k3', 're7'])
    expect(getEulerLabelEntityKeys({ entity: '' } as EulerLabelProduct)).toEqual([])
  })

  it('detects products managed by a slug', () => {
    const product = { entity: ['k3', 're7'] } as EulerLabelProduct

    expect(isEulerLabelProductManagedBy(product, 're7')).toBe(true)
    expect(isEulerLabelProductManagedBy(product, 'mev-capital')).toBe(false)
  })

  it('resolves an entity slug by reference or stable fields', () => {
    const k3 = entity('K3')
    const entities = { k3, re7: entity('Re7') }

    expect(getEulerLabelEntitySlug(entities, k3)).toBe('k3')
    expect(getEulerLabelEntitySlug(entities, { ...k3 })).toBe('k3')
  })

  it('formats compact manager labels', () => {
    expect(getEulerLabelEntityDisplayName([])).toBe('')
    expect(getEulerLabelEntityDisplayName([entity('K3')])).toBe('K3')
    expect(getEulerLabelEntityDisplayName([entity('K3'), entity('Re7')])).toBe('K3 & Re7')
    expect(getEulerLabelEntityDisplayName([entity('K3'), entity('Re7'), entity('MEV Capital')])).toBe('K3 & others')
  })

  it('builds manager profile paths', () => {
    expect(getManagerProfilePath('mev-capital')).toBe('/managers/mev-capital')
  })

  it('normalizes manager social handles into external URLs', () => {
    expect(getManagerProfileSocialUrl('twitter', '@k3_capital')).toBe('https://x.com/k3_capital')
    expect(getManagerProfileSocialUrl('github', 'euler-xyz')).toBe('https://github.com/euler-xyz')
    expect(getManagerProfileSocialUrl('telegram', 'https://t.me/UsualCommunity')).toBe('https://t.me/UsualCommunity')
    expect(getManagerProfileSocialUrl('discord', 'hhttps://discord.usual.money/')).toBe('https://discord.usual.money/')
    expect(getManagerProfileExternalUrl('example.com')).toBe('https://example.com')
  })

  it('builds social links from entity metadata', () => {
    expect(getManagerProfileSocialLinks({
      ...entity('K3'),
      url: 'k3.capital',
      social: {
        twitter: 'k3_capital',
        youtube: '',
        discord: '',
        telegram: '',
        github: 'k3-capital',
        legal: 'legal.k3.capital',
      },
    })).toEqual([
      { label: 'Website', url: 'https://k3.capital' },
      { label: 'X', url: 'https://x.com/k3_capital' },
      { label: 'GitHub', url: 'https://github.com/k3-capital' },
      { label: 'Legal', url: 'https://legal.k3.capital' },
    ])
  })
})
