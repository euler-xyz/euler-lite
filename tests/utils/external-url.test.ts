import { describe, expect, it } from 'vitest'
import { safeExternalHttpUrl } from '~/utils/external-url'

describe('safeExternalHttpUrl', () => {
  it('passes through absolute HTTP(S) URLs', () => {
    expect(safeExternalHttpUrl('https://example.com/path')).toBe('https://example.com/path')
    expect(safeExternalHttpUrl('http://example.com')).toBe('http://example.com')
  })

  it.each([
    'javascript:alert(1)',
    'JavaScript:alert(1)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
    'file:///etc/passwd',
    'blob:https://example.com/id',
    '/relative',
    '//example.com/path',
    'not a url',
  ])('rejects a non-HTTP(S) external URL (%s)', (value) => {
    expect(safeExternalHttpUrl(value)).toBeUndefined()
  })

  it('rejects empty and non-string values', () => {
    expect(safeExternalHttpUrl('')).toBeUndefined()
    expect(safeExternalHttpUrl(undefined)).toBeUndefined()
    expect(safeExternalHttpUrl(null)).toBeUndefined()
    expect(safeExternalHttpUrl(42)).toBeUndefined()
  })
})
