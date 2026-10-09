import { describe, expect, it, vi } from 'vitest'

const A = '0x00000000000000000000000000000000000000a1'
const B = '0x00000000000000000000000000000000000000b2'
const C = '0x00000000000000000000000000000000000000c3'

const v3Token = (address: string, extra: Record<string, unknown> = {}) => ({
  chainId: 1,
  address,
  name: 'Token',
  symbol: 'TKN',
  decimals: 18,
  logoURI: `https://v3.example/v3/images/tokens/1/${address}?v=abcd1234`,
  ...extra,
})

const mocks = vi.hoisted(() => ({
  fetchWithTimeout: vi.fn(),
}))

vi.mock('h3', () => ({
  createError: (error: unknown) => error,
  getQuery: (event: { query?: Record<string, string> }) => event.query ?? {},
  setResponseHeader: vi.fn(),
}))

vi.mock('~/server/utils/fetchWithTimeout', () => ({
  fetchWithTimeout: mocks.fetchWithTimeout,
}))

vi.mock('~/server/utils/rate-limit', () => ({
  createRateLimiter: () => ({ consume: vi.fn() }),
}))

vi.mock('~/server/utils/log', () => ({
  reportStatus: vi.fn(),
}))

vi.mock('@eulerxyz/euler-v2-sdk', () => ({
  buildEulerSDK: async () => {
    let queryTokenList: (url: string) => Promise<Record<string, unknown>[]> = async () => []
    return {
      tokenlistService: {
        setQueryTokenList: (fn: typeof queryTokenList) => {
          queryTokenList = fn
        },
        loadTokenlist: async (chainId: number) =>
          (await queryTokenList(`https://v3.example/v3/tokens?chainId=${chainId}&limit=500`)).map(token => ({
            chainId: token.chainId,
            address: token.address,
            name: token.name,
            symbol: token.symbol,
            decimals: token.decimals,
            logoURI: token.logoURI ?? '',
          })),
      },
    }
  },
}))

const respond = (body: unknown) => Response.json(body)

const routeUpstreams = (v3Tokens: Record<string, unknown>[]) => {
  mocks.fetchWithTimeout.mockImplementation(async (url: string) => {
    if (url.startsWith('https://v3.example/v3/tokens')) {
      return respond({ data: v3Tokens, meta: { total: v3Tokens.length, limit: 500, offset: 0 } })
    }
    if (url.includes('tokenlists-1.json')) {
      return respond({ [A]: { chainId: 1, address: A, name: 'A', symbol: 'A', decimals: 18, logoURI: 'https://llama.example/a.png' } })
    }
    if (url.includes('uniswap')) return respond({ tokens: [] })
    return respond({})
  })
}

const importRoute = async () => {
  vi.resetModules()
  return import('~/server/api/internal/token-list.get')
}

describe('/api/internal/token-list logos', () => {
  it('replaces a V3 logo only when V3 says it has no image, and never returns the flag', async () => {
    routeUpstreams([
      v3Token(A, { hasLogo: false }),
      v3Token(B, { hasLogo: true }),
      v3Token(C),
    ])
    const { refreshTokenList } = await importRoute()

    const tokens = await refreshTokenList(1)
    const byAddress = new Map(tokens.map(token => [token.address.toLowerCase(), token]))

    expect(byAddress.get(A)?.logoURI).toBe('https://llama.example/a.png')
    expect(byAddress.get(B)?.logoURI).toBe(v3Token(B).logoURI)
    expect(byAddress.get(C)?.logoURI).toBe(v3Token(C).logoURI)
    expect(tokens.some(token => 'hasLogo' in token)).toBe(false)
  })

  it('stops replacing a logo once V3 stops sending the flag', async () => {
    routeUpstreams([v3Token(A, { hasLogo: false })])
    const { refreshTokenList } = await importRoute()
    await refreshTokenList(1)

    routeUpstreams([v3Token(A)])
    const tokens = await refreshTokenList(1)

    expect(tokens.find(token => token.address.toLowerCase() === A)?.logoURI).toBe(v3Token(A).logoURI)
  })
})
