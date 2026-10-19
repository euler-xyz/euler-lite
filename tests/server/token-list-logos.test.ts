import { describe, expect, it } from 'vitest'
import { preferFallbackLogos, readV3LogoFlags, replaceV3LogoFlags } from '~/server/utils/token-list-logos'

const A = '0x00000000000000000000000000000000000000A1'
const B = '0x00000000000000000000000000000000000000b2'
const C = '0x00000000000000000000000000000000000000c3'

const token = (address: string, overrides: Record<string, unknown> = {}) => ({
  chainId: 1,
  address,
  name: 'Token',
  symbol: 'TKN',
  decimals: 18,
  logoURI: `https://v3.example/v3/images/tokens/1/${address}`,
  ...overrides,
})

describe('readV3LogoFlags', () => {
  it('keys boolean hasLogo flags by chain and lowercase address', () => {
    const flags = readV3LogoFlags([
      token(A, { hasLogo: false }),
      token(B, { hasLogo: true }),
      token(C),
      token(C, { chainId: 10, hasLogo: 'no' }),
      null,
      { hasLogo: false },
    ])

    expect([...flags]).toEqual([
      [`1:${A.toLowerCase()}`, false],
      [`1:${B.toLowerCase()}`, true],
    ])
  })
})

describe('replaceV3LogoFlags', () => {
  it('replaces the flags of the chains in a response and keeps other chains', () => {
    const current = new Map([
      [`1:${A.toLowerCase()}`, false],
      [`10:${B.toLowerCase()}`, false],
    ])
    const next = replaceV3LogoFlags(current, [token(C, { hasLogo: true }), token(A)])

    expect([...next]).toEqual([
      [`10:${B.toLowerCase()}`, false],
      [`1:${C.toLowerCase()}`, true],
    ])
    expect(current.size).toBe(2)
  })
})

describe('preferFallbackLogos', () => {
  const defillama = [
    { chainId: 1, address: A.toLowerCase(), logoURI: 'https://llama.example/a.png' },
  ]
  const uniswap = [
    { chainId: 1, address: A, logoURI: 'https://uni.example/a.png' },
    { chainId: 1, address: B, logoURI: 'https://uni.example/b.png' },
  ]

  it('uses the first secondary logo when V3 has no image for the token', () => {
    const [a, b] = preferFallbackLogos(
      [token(A, { hasLogo: false }), token(B, { hasLogo: false })],
      [defillama, uniswap],
    )

    expect(a.logoURI).toBe('https://llama.example/a.png')
    expect(b.logoURI).toBe('https://uni.example/b.png')
  })

  it('skips an empty secondary logo and takes the next list', () => {
    const [b] = preferFallbackLogos(
      [token(B, { hasLogo: false })],
      [[{ chainId: 1, address: B, logoURI: '' }], uniswap],
    )

    expect(b.logoURI).toBe('https://uni.example/b.png')
  })

  it('keeps the V3 logo when V3 has no image and no other list has one', () => {
    const withoutImage = token(C, { hasLogo: false })
    const [c] = preferFallbackLogos([withoutImage], [defillama, uniswap])

    expect(c.logoURI).toBe(withoutImage.logoURI)
  })

  it('returns no logo when neither V3 nor any other list has one', () => {
    const [c] = preferFallbackLogos([token(C, { hasLogo: false, logoURI: undefined })], [defillama, uniswap])

    expect(c).not.toHaveProperty('logoURI')
  })

  it('keeps the V3 logo when V3 has an image or does not say', () => {
    const withImage = token(A, { hasLogo: true })
    const oldV3 = token(B)
    const [a, b] = preferFallbackLogos([withImage, oldV3], [defillama, uniswap])

    expect(a.logoURI).toBe(withImage.logoURI)
    expect(b.logoURI).toBe(oldV3.logoURI)
  })

  it('never returns the hasLogo flag', () => {
    const tokens = preferFallbackLogos(
      [token(A, { hasLogo: false }), token(B, { hasLogo: true }), token(C)],
      [defillama],
    )

    expect(tokens.every(entry => !('hasLogo' in entry))).toBe(true)
  })
})
