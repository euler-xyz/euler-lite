import { describe, expect, it } from 'vitest'
import { DEFAULT_V3_API_URL, DEFAULT_V3_IMAGES_URL, normalizeV3ImagesUrl, readMerklApiKey, readResolvedV3ApiUrl, readTurtleEarnApiKey, readV3ApiKey, readV3ApiUrl, readV3ImagesUrl } from '~/utils/api-url-env'

describe('api-url-env', () => {
  it('reads the public V3 images URL separately from the private V3 API URL', () => {
    expect(DEFAULT_V3_IMAGES_URL).toBe('https://v3.euler.finance')
    expect(readV3ImagesUrl({})).toBe(DEFAULT_V3_IMAGES_URL)
    expect(readV3ImagesUrl({ V3_API_URL: 'http://v3-internal:3000' })).toBe(DEFAULT_V3_IMAGES_URL)
    expect(readV3ImagesUrl({ V3_IMAGES_URL: 'https://images.example/' })).toBe('https://images.example')
    expect(readV3ImagesUrl({ NUXT_PUBLIC_V3_IMAGES_URL: 'https://public-images.example' })).toBe('https://public-images.example')
  })

  it('accepts only a plain https image host', () => {
    expect(normalizeV3ImagesUrl(' https://images.example/base// ')).toBe('https://images.example/base')
    expect(normalizeV3ImagesUrl('http://localhost:3001')).toBe(DEFAULT_V3_IMAGES_URL)
    expect(normalizeV3ImagesUrl('https://images.example/?v=2')).toBe(DEFAULT_V3_IMAGES_URL)
    expect(normalizeV3ImagesUrl('https://images.example/#top')).toBe(DEFAULT_V3_IMAGES_URL)
    expect(normalizeV3ImagesUrl('https://user:secret@images.example')).toBe(DEFAULT_V3_IMAGES_URL)
    expect(normalizeV3ImagesUrl('javascript:alert(1)')).toBe(DEFAULT_V3_IMAGES_URL)
    expect(normalizeV3ImagesUrl('not a url')).toBe(DEFAULT_V3_IMAGES_URL)
    expect(normalizeV3ImagesUrl(undefined)).toBe(DEFAULT_V3_IMAGES_URL)
  })

  it('ignores non-V3 API URL variables', () => {
    const env = {
      OTHER_API_URL: 'https://example.test',
      NUXT_PUBLIC_OTHER_API_URL: 'https://public.example.test',
    }

    expect(readV3ApiUrl(env)).toBe('')
  })

  it('reads explicit V3 API variables in runtime precedence order', () => {
    expect(readV3ApiUrl({
      EULER_SDK_V3_API_URL: 'https://sdk-v3.example',
      NUXT_PUBLIC_V3_API_URL: 'https://public-v3.example',
    })).toBe('https://sdk-v3.example')

    expect(readV3ApiUrl({
      V3_API_URL: 'https://v3.example',
      EULER_SDK_V3_API_URL: 'https://sdk-v3.example',
    })).toBe('https://v3.example')
  })

  it('reads server-side V3 API key variables in runtime precedence order', () => {
    expect(readV3ApiKey({
      EULER_SDK_V3_API_KEY: 'sdk-key',
      EULER_V3_API_KEY: 'legacy-key',
    })).toBe('sdk-key')

    expect(readV3ApiKey({
      V3_API_KEY: 'v3-key',
      EULER_SDK_V3_API_KEY: 'sdk-key',
    })).toBe('v3-key')
  })

  it('does not read public V3 API key variables', () => {
    expect(readV3ApiKey({
      NUXT_PUBLIC_V3_API_KEY: 'public-key',
      VITE_EULER_V3_API_KEY: 'vite-key',
    })).toBe('')
  })

  it('reads the server-side Merkl API key', () => {
    expect(readMerklApiKey({})).toBe('')
    expect(readMerklApiKey({ MERKL_API_KEY: 'merkl-secret' })).toBe('merkl-secret')
  })

  it('does not read public Merkl API key variables', () => {
    expect(readMerklApiKey({
      NUXT_PUBLIC_MERKL_API_KEY: 'public-key',
    })).toBe('')
  })

  it('reads the server-side Turtle Earn API key', () => {
    expect(readTurtleEarnApiKey({})).toBe('')
    expect(readTurtleEarnApiKey({ TURTLE_EARN_API_KEY: 'sk_live_secret' })).toBe('sk_live_secret')
  })

  it('does not read public Turtle API key variables', () => {
    expect(readTurtleEarnApiKey({
      NUXT_PUBLIC_TURTLE_EARN_API_KEY: 'pk_live_public',
      TURTLE_API_KEY: 'other-name',
    })).toBe('')
  })

  it('falls back to the default V3 API URL', () => {
    expect(readResolvedV3ApiUrl({})).toBe(DEFAULT_V3_API_URL)
    expect(readResolvedV3ApiUrl({ V3_API_URL: 'https://v3.example/' })).toBe('https://v3.example')
  })
})
