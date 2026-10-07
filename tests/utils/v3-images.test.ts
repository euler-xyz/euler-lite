import { describe, expect, it } from 'vitest'
import { parsePublicImagesBaseUrl, v3ChainLogoUrl, v3OracleProviderLogoUrl } from '~/utils/v3-images'

const BASE = 'https://v3.example/v3/images'

describe('V3 image URLs', () => {
  it('builds chain and oracle-provider logo URLs under the published images base', () => {
    expect(v3ChainLogoUrl(8453, BASE)).toBe('https://v3.example/v3/images/chains/8453')
    expect(v3OracleProviderLogoUrl('pyth', BASE)).toBe('https://v3.example/v3/images/oracle-providers/pyth')
  })

  it('encodes the oracle provider key as one path segment', () => {
    expect(v3OracleProviderLogoUrl('a/b', BASE)).toBe('https://v3.example/v3/images/oracle-providers/a%2Fb')
  })

  it('builds no URL when the images base is unknown', () => {
    expect(v3ChainLogoUrl(1, '')).toBe('')
    expect(v3ChainLogoUrl(1, undefined)).toBe('')
    expect(v3OracleProviderLogoUrl('pyth', '')).toBeUndefined()
  })
})

describe('parsePublicImagesBaseUrl', () => {
  it('accepts a plain https URL and drops a trailing slash', () => {
    expect(parsePublicImagesBaseUrl('https://v3.example/v3/images/')).toBe(BASE)
    expect(parsePublicImagesBaseUrl(` ${BASE} `)).toBe(BASE)
  })

  it('rejects anything else', () => {
    for (const value of [
      'http://v3.example/v3/images',
      'https://v3.example/v3/images?v=2',
      'https://v3.example/v3/images#top',
      'https://user:secret@v3.example/v3/images',
      'javascript:alert(1)',
      'not a url',
      '',
      42,
      null,
      undefined,
    ]) {
      expect(parsePublicImagesBaseUrl(value)).toBe('')
    }
  })
})
