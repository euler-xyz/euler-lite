import { describe, expect, it } from 'vitest'
import { DEFAULT_V3_API_URL, readMerklApiKey, readResolvedV3ApiUrl, readV3ApiKey, readV3ApiUrl } from '~/utils/api-url-env'

describe('api-url-env', () => {
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

  it('falls back to the default V3 API URL', () => {
    expect(readResolvedV3ApiUrl({})).toBe(DEFAULT_V3_API_URL)
    expect(readResolvedV3ApiUrl({ V3_API_URL: 'https://v3.example/' })).toBe('https://v3.example')
  })
})
