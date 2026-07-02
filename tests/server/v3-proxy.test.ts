import { describe, expect, it } from 'vitest'
import {
  buildV3ProxyRequestHeaders,
  buildV3ProxyTarget,
  isV3ProxyPathAllowed,
  readForwardedV3ResponseHeaders,
  validateV3ProxyUrl,
} from '~/server/utils/v3-proxy'

const ACCOUNT = '0x0000000000000000000000000000000000000001'
const VAULT = '0x0000000000000000000000000000000000000002'

describe('v3 proxy utilities', () => {
  it('maps /api/internal/v3 requests to the configured upstream', () => {
    const target = buildV3ProxyTarget(
      new URL('https://app.example/api/internal/v3/evk/vaults/batch?chainId=1'),
      { V3_API_URL: 'https://v3.example/base/' },
    )

    expect(target).toBe('https://v3.example/base/v3/evk/vaults/batch?chainId=1')
  })

  it('keeps legacy /api/internal/v3/v3 requests mapped to the same upstream', () => {
    const target = buildV3ProxyTarget(
      new URL('https://app.example/api/internal/v3/v3/evk/vaults/batch?chainId=1'),
      { V3_API_URL: 'https://v3.example/base/' },
    )

    expect(target).toBe('https://v3.example/base/v3/evk/vaults/batch?chainId=1')
  })

  it('allows only SDK-owned V3 path shapes', () => {
    expect(isV3ProxyPathAllowed(`/v3/accounts/${ACCOUNT}/positions`)).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/apys/intrinsic')).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/apys/rewards')).toBe(true)
    expect(isV3ProxyPathAllowed(`/v3/earn/vaults/1/${VAULT}`)).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/evk/vaults/bad-debt')).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/evk/vaults/batch')).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/evk/vaults/open-interest')).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/evk/vaults/open-interest/by-collateral')).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/prices')).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/resolve/vaults')).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/rewards/breakdown')).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/tokens')).toBe(true)
  })

  it('rejects unrelated V3 paths and prefix lookalikes', () => {
    expect(isV3ProxyPathAllowed('/v3/admin')).toBe(false)
    expect(isV3ProxyPathAllowed('/v3/accounting')).toBe(false)
    expect(isV3ProxyPathAllowed('/v3/evk/vaults/bad-debt/history')).toBe(false)
    expect(isV3ProxyPathAllowed('/v3/evk/vaults-admin')).toBe(false)
    expect(isV3ProxyPathAllowed('/v3/apys/unknown')).toBe(false)
    expect(isV3ProxyPathAllowed('/v3/resolve')).toBe(false)
  })

  it('allows query strings on SDK-owned endpoints for V3 to validate', () => {
    expect(validateV3ProxyUrl(
      'GET',
      new URL(`https://app.example/api/internal/v3/accounts/${ACCOUNT}/positions?chainId=1&offset=0&limit=100`),
    )).toEqual({ ok: true })
    expect(validateV3ProxyUrl(
      'GET',
      new URL(`https://app.example/api/internal/v3/prices?chainId=1&assets=${ACCOUNT},${VAULT}&limit=100`),
    )).toEqual({ ok: true })
    expect(validateV3ProxyUrl(
      'GET',
      new URL(`https://app.example/api/internal/v3/evk/vaults/open-interest?chainId=1&vault=${VAULT}&limit=1`),
    )).toEqual({ ok: true })
    expect(validateV3ProxyUrl(
      'GET',
      new URL('https://app.example/api/internal/v3/evk/vaults/open-interest/by-collateral?chainId=1'),
    )).toEqual({ ok: true })
    expect(validateV3ProxyUrl(
      'GET',
      new URL('https://app.example/api/internal/v3/tokens?chainId=1&limit=500&type=base'),
    )).toEqual({ ok: true })
    expect(validateV3ProxyUrl(
      'GET',
      new URL(`https://app.example/api/internal/v3/prices?chainId=1&assets=${ACCOUNT}&limit=100&debug=true`),
    )).toEqual({ ok: true })
  })

  it('rejects unknown paths and wrong methods', () => {
    expect(validateV3ProxyUrl(
      'GET',
      new URL('https://app.example/api/internal/v3/admin?chainId=1'),
    )).toMatchObject({ ok: false, statusCode: 404 })
    expect(validateV3ProxyUrl(
      'POST',
      new URL('https://app.example/api/internal/v3/prices'),
    )).toMatchObject({ ok: false, statusCode: 405 })
  })

  it('injects only fixed SDK headers and the server-side API key', () => {
    const headers = buildV3ProxyRequestHeaders('POST', {
      EULER_SDK_V3_API_KEY: 'server-key',
    })

    expect(headers.get('accept')).toBe('application/json')
    expect(headers.get('content-type')).toBe('application/json')
    expect(headers.get('cookie')).toBeNull()
    expect(headers.get('cf-connecting-ip')).toBeNull()
    expect(headers.get('x-api-key')).toBe('server-key')
  })

  it('forwards only response headers useful to SDK callers', () => {
    const headers = new Headers({
      'content-type': 'application/json',
      'cache-control': 'public, max-age=30',
      'cf-ray': 'example-ray',
      'set-cookie': 'sid=secret',
    })

    expect(readForwardedV3ResponseHeaders(headers)).toEqual({
      'cache-control': 'public, max-age=30',
      'cf-ray': 'example-ray',
      'content-type': 'application/json',
    })
  })
})
