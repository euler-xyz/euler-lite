import { describe, expect, it } from 'vitest'
import { readV3ApiUrl } from '~/utils/api-url-env'

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
})
