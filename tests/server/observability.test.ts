import { describe, expect, it } from 'vitest'
import { safeErrorLogFields, safePathTemplate, safeUrlLogFields, searchKeys, summarizeSdkIssue, urlHost } from '~/server/utils/observability'

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
