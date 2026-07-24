import { describe, expect, it } from 'vitest'
import { safeExternalHttpUrl } from '~/utils/external-url'

describe('safeExternalHttpUrl', () => {
  it('passes through absolute http(s) URLs unchanged', () => {
    expect(safeExternalHttpUrl('https://app.merkl.xyz/opportunities/1')).toBe('https://app.merkl.xyz/opportunities/1')
    expect(safeExternalHttpUrl('http://example.com')).toBe('http://example.com')
  })

  it('rejects script-bearing schemes', () => {
    expect(safeExternalHttpUrl('javascript:alert(1)')).toBeUndefined()
    expect(safeExternalHttpUrl('JavaScript:alert(1)')).toBeUndefined()
    expect(safeExternalHttpUrl('data:text/html,<script>alert(1)</script>')).toBeUndefined()
    expect(safeExternalHttpUrl('vbscript:msgbox(1)')).toBeUndefined()
  })

  it('rejects other non-http schemes', () => {
    expect(safeExternalHttpUrl('file:///etc/passwd')).toBeUndefined()
    expect(safeExternalHttpUrl('blob:https://example.com/uuid')).toBeUndefined()
  })

  it('rejects relative and scheme-relative values (an external URL must be absolute)', () => {
    expect(safeExternalHttpUrl('/opportunities/1')).toBeUndefined()
    expect(safeExternalHttpUrl('//evil.example.com')).toBeUndefined()
    expect(safeExternalHttpUrl('not a url')).toBeUndefined()
  })

  it('rejects empty and non-string input', () => {
    expect(safeExternalHttpUrl('')).toBeUndefined()
    expect(safeExternalHttpUrl(undefined)).toBeUndefined()
    expect(safeExternalHttpUrl(null)).toBeUndefined()
    expect(safeExternalHttpUrl(42)).toBeUndefined()
    expect(safeExternalHttpUrl({ href: 'https://example.com' })).toBeUndefined()
  })
})
