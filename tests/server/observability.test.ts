import { describe, expect, it } from 'vitest'
import { buildVaultAssetLookup, hashIdentifier, safeErrorLogFields, safePathTemplate, safeUrlLogFields, searchKeys, summarizeSdkIssue, urlHost } from '~/server/utils/observability'

const VAULT = '0x0000000000000000000000000000000000000a01'
const COLLATERAL = '0x0000000000000000000000000000000000000a02'
const ASSET = '0x0000000000000000000000000000000000000b01'
const ACCOUNT = '0x00000000000000000000000000000000000c0ffe'

describe('SDK issue locations in logs', () => {
  const assetForVault = buildVaultAssetLookup([
    { address: VAULT.toUpperCase().replace('0X', '0x'), asset: { address: ASSET, symbol: 'USDC' } },
    { address: '0x0000000000000000000000000000000000000a03', asset: { symbol: 'NOADDR' } },
    null,
  ])

  it('names the asset behind a vault price failure', () => {
    const summary = summarizeSdkIssue({
      code: 'SOURCE_UNAVAILABLE',
      severity: 'error',
      message: 'Failed to get asset USD price.',
      source: 'priceService',
      locations: [
        { owner: { kind: 'vault', chainId: 1, address: VAULT }, path: '$.marketPriceUsd' },
        { owner: { kind: 'asset', chainId: 1, address: ASSET }, path: '$' },
        { owner: { kind: 'vaultCollateral', chainId: 1, vault: VAULT, collateral: COLLATERAL }, path: '$.marketPriceUsd' },
      ],
    }, assetForVault)

    expect(summary.locations).toEqual([
      { kind: 'vault', chainId: 1, vault: VAULT, asset: ASSET, assetSymbol: 'USDC', path: '$.marketPriceUsd' },
      { kind: 'asset', chainId: 1, asset: ASSET, path: '$' },
      { kind: 'vaultCollateral', chainId: 1, vault: VAULT, collateral: COLLATERAL, path: '$.marketPriceUsd' },
    ])
    expect(summary.message).toBe('Failed to get asset USD price.')
  })

  it('hashes account addresses and drops service ids', () => {
    const summary = summarizeSdkIssue({
      code: 'SOURCE_UNAVAILABLE',
      locations: [
        { owner: { kind: 'accountPosition', chainId: 1, account: ACCOUNT, vault: VAULT }, path: '$.suppliedValueUsd' },
        { owner: { kind: 'service', service: 'pricing', chainId: 1, id: 'secret-id' }, path: '$' },
      ],
    }, assetForVault)

    expect(summary.locations).toEqual([
      { kind: 'accountPosition', chainId: 1, vault: VAULT, asset: ASSET, assetSymbol: 'USDC', account: hashIdentifier(ACCOUNT), path: '$.suppliedValueUsd' },
      { kind: 'service', chainId: 1, service: 'pricing', path: '$' },
    ])
    expect(JSON.stringify(summary)).not.toContain('c0ffe')
    expect(JSON.stringify(summary)).not.toContain('secret-id')
  })

  it('caps the logged locations and reports how many there were', () => {
    const locations = Array.from({ length: 7 }, (_, index) => ({
      owner: { kind: 'asset', chainId: 1, address: `0x${(index + 1).toString(16).padStart(40, '0')}` },
      path: '$',
    }))
    const summary = summarizeSdkIssue({ code: 'SOURCE_UNAVAILABLE', locations })

    expect(summary.locations).toHaveLength(5)
    expect(summary.locationCount).toBe(7)
  })

  it('skips malformed locations and fields', () => {
    const summary = summarizeSdkIssue({
      code: 'SOURCE_UNAVAILABLE',
      locations: [
        null,
        { path: '$' },
        { owner: { kind: 'asset', chainId: 1, address: 'not-an-address' }, path: 42 },
        { owner: { kind: 'mystery', chainId: 1 } },
      ],
    })

    expect(summary).toEqual({ code: 'SOURCE_UNAVAILABLE', locations: [{ kind: 'asset', chainId: 1 }] })
  })
})

describe('server observability helpers', () => {
  it('summarizes SDK issues without raw nested diagnostics', () => {
    const summary = summarizeSdkIssue({
      code: 'bad-vault',
      severity: 'warn',
      source: 'sdk',
      originalValue: { calldata: '0xdeadbeef' },
      err: new Error('private details'),
      metaMessages: ['leaky'],
    })

    expect(summary).toEqual({
      code: 'bad-vault',
      severity: 'warn',
      source: 'sdk',
    })
    expect(JSON.stringify(summary)).not.toContain('0xdeadbeef')
    expect(JSON.stringify(summary)).not.toContain('metaMessages')
  })

  it('reduces URLs and paths to query-safe metadata', () => {
    const url = new URL('https://api.example/private/key/users/0x0000000000000000000000000000000000000001/rewards?user_address=0xabc&chain_id=1')
    expect(urlHost(url.toString())).toBe('api.example')
    expect(safePathTemplate(url.pathname)).toBe('/private/key/users/:address/rewards')
    expect(searchKeys(url.searchParams)).toEqual(['chain_id', 'user_address'])
    expect(safeUrlLogFields(url.toString())).toEqual({
      upstreamHost: 'api.example',
      searchKeys: ['chain_id', 'user_address'],
    })
  })

  it('does not include path-embedded provider tokens in URL log metadata', () => {
    const fields = safeUrlLogFields('https://provider.example/v2/secret-token/rpc?key=x')

    expect(fields).toEqual({
      upstreamHost: 'provider.example',
      searchKeys: ['key'],
    })
    expect(JSON.stringify(fields)).not.toContain('secret-token')
  })

  it('does not throw or leak raw malformed URLs in log metadata', () => {
    expect(safeUrlLogFields('not a url / secret-key')).toEqual({ searchKeys: [] })
  })

  it('summarizes proxy errors without URL-bearing messages', () => {
    const cause = new TypeError('Failed to parse URL from not a url / secret-key')
    const error = Object.assign(new Error('Failed to parse URL from https://rpc.example/private-token'), {
      code: 'ERR_INVALID_URL',
      cause,
    })

    const fields = safeErrorLogFields(error)

    expect(fields).toEqual({
      name: 'Error',
      code: 'ERR_INVALID_URL',
      causeName: 'TypeError',
    })
    expect(JSON.stringify(fields)).not.toContain('private-token')
    expect(JSON.stringify(fields)).not.toContain('secret-key')
  })
})
