import { describe, expect, it } from 'vitest'
import { buildTokenLogoMap } from '~/server/utils/labels-view'

describe('buildTokenLogoMap', () => {
  it('keeps only http(s) logo URLs', () => {
    const map = buildTokenLogoMap([
      { address: '0x1111111111111111111111111111111111111111', logoURI: 'https://cdn.example/token.png' },
      { address: '0x2222222222222222222222222222222222222222', logoURI: 'http://cdn.example/token.png' },
      { address: '0x3333333333333333333333333333333333333333', logoURI: 'javascript:alert(1)' },
      { address: '0x4444444444444444444444444444444444444444', logoURI: 'data:image/svg+xml,<svg />' },
      { address: '0x5555555555555555555555555555555555555555', logoURI: '/relative-token.png' },
      { address: '0x6666666666666666666666666666666666666666', logoURI: 'not a url' },
    ])

    expect(map.get('0x1111111111111111111111111111111111111111')).toBe('https://cdn.example/token.png')
    expect(map.get('0x2222222222222222222222222222222222222222')).toBe('http://cdn.example/token.png')
    expect(map.has('0x3333333333333333333333333333333333333333')).toBe(false)
    expect(map.has('0x4444444444444444444444444444444444444444')).toBe(false)
    expect(map.has('0x5555555555555555555555555555555555555555')).toBe(false)
    expect(map.has('0x6666666666666666666666666666666666666666')).toBe(false)
  })
})
