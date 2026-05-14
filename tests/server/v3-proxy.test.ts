import { describe, expect, it } from 'vitest'
import {
  buildV3ProxyRequestHeaders,
  buildV3ProxyTarget,
  isV3ProxyPathAllowed,
  readForwardedV3ResponseHeaders,
} from '~/server/utils/v3-proxy'

describe('v3 proxy utilities', () => {
  it('maps /api/v3 requests to the configured upstream', () => {
    const target = buildV3ProxyTarget(
      new URL('https://app.example/api/v3/v3/evk/vaults/batch?chainId=1'),
      { V3_API_URL: 'https://v3.example/base/' },
    )

    expect(target).toBe('https://v3.example/base/v3/evk/vaults/batch?chainId=1')
  })

  it('allows SDK-owned V3 paths', () => {
    expect(isV3ProxyPathAllowed('/v3/accounts/0x123/positions')).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/apys/intrinsic')).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/earn/vaults/1/0x123')).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/evk/vaults/batch')).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/prices')).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/resolve/vaults')).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/rewards/breakdown')).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/tokens')).toBe(true)
  })

  it('rejects unrelated V3 paths and prefix lookalikes', () => {
    expect(isV3ProxyPathAllowed('/v3/admin')).toBe(false)
    expect(isV3ProxyPathAllowed('/v3/accounting')).toBe(false)
    expect(isV3ProxyPathAllowed('/v3/evk/vaults-admin')).toBe(false)
    expect(isV3ProxyPathAllowed('/v3/resolve')).toBe(false)
  })

  it('injects the server-side API key and strips client-controlled credentials', () => {
    const headers = buildV3ProxyRequestHeaders({
      'accept': 'application/json',
      'cookie': 'session=secret',
      'x-api-key': 'client-key',
      'cf-connecting-ip': '203.0.113.10',
    }, {
      EULER_SDK_V3_API_KEY: 'server-key',
    })

    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('cf-connecting-ip')).toBeNull()
    expect(headers.get('x-api-key')).toBe('server-key')
  })

  it('forwards only response headers useful to SDK callers', () => {
    const headers = new Headers({
      'content-type': 'application/json',
      'cache-control': 'public, max-age=30',
      'set-cookie': 'sid=secret',
    })

    expect(readForwardedV3ResponseHeaders(headers)).toEqual({
      'cache-control': 'public, max-age=30',
      'content-type': 'application/json',
    })
  })
})
