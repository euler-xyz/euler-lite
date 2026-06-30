import { describe, expect, it } from 'vitest'
import { safePathTemplate, searchKeys, summarizeSdkIssue, urlHost } from '~/server/utils/observability'

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
  })
})
