import { describe, expect, it } from 'vitest'
import {
  buildV3ProxyLogFields,
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
    expect(isV3ProxyPathAllowed(`/v3/activity/accounts/${ACCOUNT}/events`)).toBe(true)
    expect(isV3ProxyPathAllowed(`/v3/activity/vaults/1/${VAULT}/events`)).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/apys/intrinsic')).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/apys/rewards')).toBe(true)
    expect(isV3ProxyPathAllowed(`/v3/earn/vaults/1/${VAULT}`)).toBe(true)
    expect(isV3ProxyPathAllowed(`/v3/earn/vaults/1/${VAULT}/totals`)).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/evk/vaults/bad-debt')).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/evk/vaults/batch')).toBe(true)
    expect(isV3ProxyPathAllowed(`/v3/evk/vaults/1/${VAULT}/totals`)).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/evk/vaults/open-interest')).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/evk/vaults/open-interest/by-collateral')).toBe(true)
    expect(isV3ProxyPathAllowed('/v3/liquidations')).toBe(true)
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
    expect(isV3ProxyPathAllowed('/v3/liquidations/admin')).toBe(false)
    expect(isV3ProxyPathAllowed('/v3/liquidations-extra')).toBe(false)
    expect(isV3ProxyPathAllowed('/v3/resolve')).toBe(false)
    expect(isV3ProxyPathAllowed('/v3/activity/accounts/not-an-address/events')).toBe(false)
    expect(isV3ProxyPathAllowed(`/v3/activity/accounts/${ACCOUNT}/events/admin`)).toBe(false)
    expect(isV3ProxyPathAllowed(`/v3/activity/vaults/0/${VAULT}/events`)).toBe(false)
    expect(isV3ProxyPathAllowed(`/v3/activity/vaults/${'1'.repeat(17)}/${VAULT}/events`)).toBe(false)
    expect(isV3ProxyPathAllowed(`/v3/activity/vaults/1/not-an-address/events`)).toBe(false)
  })

  it('rejects percent-encoded path bytes before attaching the upstream API key', () => {
    for (const path of [
      `/api/internal/v3/accounts/${ACCOUNT}%2Fadmin/positions`,
      `/api/internal/v3/accounts/${ACCOUNT}%5Cadmin/positions`,
      `/api/internal/v3/accounts/${ACCOUNT}%2e%2e/positions`,
      `/api/internal/v3/accounts/${ACCOUNT}%00/positions`,
    ]) {
      expect(validateV3ProxyUrl('GET', new URL(`https://app.example${path}`)))
        .toMatchObject({ ok: false, statusCode: 400 })
    }
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
      new URL(`https://app.example/api/internal/v3/evk/vaults/1/${VAULT}/totals?resolution=1d&from=1782380000&to=1782984800`),
    )).toEqual({ ok: true })
    expect(validateV3ProxyUrl(
      'GET',
      new URL(`https://app.example/api/internal/v3/earn/vaults/1/${VAULT}/totals?resolution=1d&from=1782380000&to=1782984800`),
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
      new URL(`https://app.example/api/internal/v3/activity/accounts/${ACCOUNT}/events?chainId=1,8453&category=lending,borrowing&cursor=opaque`),
    )).toEqual({ ok: true })
    expect(validateV3ProxyUrl(
      'GET',
      new URL(`https://app.example/api/internal/v3/activity/vaults/1/${VAULT}/events?vaultType=evk&category=governance`),
    )).toEqual({ ok: true })
    expect(validateV3ProxyUrl(
      'GET',
      new URL(`https://app.example/api/internal/v3/liquidations?chainId=1&vault=${VAULT}&violator=${ACCOUNT}&from=1782380000&to=1782984800&limit=100&offset=0`),
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

  it('extracts public vault totals failure context without raw paths', () => {
    expect(buildV3ProxyLogFields(
      new URL(`https://app.example/api/internal/v3/evk/vaults/1/${VAULT}/totals?resolution=1d&from=1782380000&to=1782984800`),
    )).toEqual({
      v3ChainId: '1',
      v3From: '1782380000',
      v3Resolution: '1d',
      v3To: '1782984800',
      v3VaultAddress: VAULT,
      v3VaultKind: 'evk',
    })
  })

  it('extracts public open-interest and bad-debt failure context', () => {
    expect(buildV3ProxyLogFields(
      new URL(`https://app.example/api/internal/v3/evk/vaults/open-interest?chainId=1&vault=${VAULT}&limit=10`),
    )).toEqual({
      v3ChainId: '1',
      v3Limit: '10',
      v3VaultAddress: VAULT,
    })

    expect(buildV3ProxyLogFields(
      new URL('https://app.example/api/internal/v3/evk/vaults/bad-debt?chainId=1&minBadDebtUsd=0&offset=100&limit=100'),
    )).toEqual({
      v3ChainId: '1',
      v3Limit: '100',
      v3MinBadDebtUsd: '0',
      v3Offset: '100',
    })
  })

  it('does not log dynamic account addresses from account-position requests', () => {
    expect(buildV3ProxyLogFields(
      new URL(`https://app.example/api/internal/v3/accounts/${ACCOUNT}/positions?chainId=1&offset=0&limit=100`),
    )).toEqual({
      v3ChainId: '1',
      v3Limit: '100',
      v3Offset: '0',
    })
  })

  it('logs bounded activity context without account addresses', () => {
    expect(buildV3ProxyLogFields(
      new URL(`https://app.example/api/internal/v3/activity/accounts/${ACCOUNT}/events?chainId=1,8453&from=1782380000&to=1782984800&category=lending,borrowing&eventType=deposit,borrow&offset=0&limit=25`),
    )).toEqual({
      v3ActivityCategories: 'lending,borrowing',
      v3ActivityEventTypes: 'deposit,borrow',
      v3ActivityScope: 'account',
      v3ChainIds: '1,8453',
      v3From: '1782380000',
      v3Limit: '25',
      v3Offset: '0',
      v3To: '1782984800',
    })

    expect(buildV3ProxyLogFields(
      new URL(`https://app.example/api/internal/v3/activity/accounts/${ACCOUNT}/events?chainId=${'1'.repeat(300)}&from=${'1'.repeat(17)}&category=${'a'.repeat(300)}`),
    )).toEqual({
      v3ActivityScope: 'account',
    })
  })

  it('logs public vault activity context', () => {
    expect(buildV3ProxyLogFields(
      new URL(`https://app.example/api/internal/v3/activity/vaults/1/${VAULT}/events?vaultType=securitize&category=lending,governance&limit=25`),
    )).toEqual({
      v3ActivityCategories: 'lending,governance',
      v3ActivityScope: 'vault',
      v3ChainId: '1',
      v3Limit: '25',
      v3VaultAddress: VAULT,
      v3VaultKind: 'securitize',
    })
  })

  it('logs liquidations context without violator or liquidator addresses', () => {
    expect(buildV3ProxyLogFields(
      new URL(`https://app.example/api/internal/v3/liquidations?chainId=1&vault=${VAULT}&violator=${ACCOUNT}&liquidator=${ACCOUNT}&from=1782380000&to=1782984800&limit=100&offset=0`),
    )).toEqual({
      v3ActivityScope: 'liquidations',
      v3ChainId: '1',
      v3From: '1782380000',
      v3Limit: '100',
      v3Offset: '0',
      v3To: '1782984800',
      v3VaultAddress: VAULT,
    })
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
