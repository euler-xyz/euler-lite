import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildProductDescriptors, buildTokenLogoMap, fetchTokenList } from '~/server/utils/labels-view'
import { INTERNAL_FETCH_HEADERS } from '~/server/utils/internal-headers'

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('fetchTokenList', () => {
  it('decorates the internal token-list fetch with the loopback sentinel', async () => {
    const fetch = vi.fn().mockResolvedValue({
      tokens: [
        { address: '0x1111111111111111111111111111111111111111', logoURI: 'https://cdn.example/token.png' },
      ],
    })
    vi.stubGlobal('$fetch', fetch)

    await expect(fetchTokenList(1)).resolves.toEqual([
      { address: '0x1111111111111111111111111111111111111111', logoURI: 'https://cdn.example/token.png' },
    ])
    expect(fetch).toHaveBeenCalledWith('/api/internal/token-list', {
      query: { chainId: 1 },
      headers: INTERNAL_FETCH_HEADERS,
    })
  })
})

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

describe('buildProductDescriptors', () => {
  it('applies governance-limited vault override tags per vault', () => {
    const limitedVault = '0x0000000000000000000000000000000000000701'
    const standardVault = '0x0000000000000000000000000000000000000702'

    const { productByVault } = buildProductDescriptors({
      test: {
        name: 'Test',
        description: '',
        entity: [],
        url: '',
        vaults: [limitedVault, standardVault],
        vaultOverrides: {
          [limitedVault]: {
            tags: ['governance limited'],
          },
        },
      },
    })

    expect(productByVault.get(limitedVault)?.governanceLimited).toBe(true)
    expect(productByVault.get(standardVault)?.governanceLimited).toBe(false)
  })
})
