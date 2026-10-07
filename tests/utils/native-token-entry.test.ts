import { describe, expect, it } from 'vitest'
import { zeroAddress } from 'viem'
import { withNativeTokenEntry } from '~/utils/native-token-entry'
import type { TokenListEntry } from '~/composables/useTokenList'

const ETH = { name: 'Ether', symbol: 'ETH', decimals: 18 }
const WETH: TokenListEntry = {
  chainId: 1,
  address: '0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2',
  name: 'Wrapped Ether',
  symbol: 'WETH',
  decimals: 18,
  logoURI: 'https://logos.example/weth.png',
  tags: ['eth'],
}

const byAddress = (entries: TokenListEntry[]) =>
  new Map(entries.map(entry => [entry.address.toLowerCase(), entry]))

describe('withNativeTokenEntry', () => {
  it('gives the native coin the wrapped native logo and tags', () => {
    const tokens = withNativeTokenEntry(byAddress([WETH]), 1, ETH)

    expect(tokens.get(zeroAddress)).toEqual({
      chainId: 1,
      address: zeroAddress,
      name: 'Ether',
      symbol: 'ETH',
      decimals: 18,
      logoURI: 'https://logos.example/weth.png',
      tags: ['eth'],
    })
  })

  it('fills a logo on a native entry the list already has without one', () => {
    const listed: TokenListEntry = { chainId: 1, address: zeroAddress, name: 'Ether', symbol: 'ETH', decimals: 18 }
    const tokens = withNativeTokenEntry(byAddress([WETH, listed]), 1, ETH)

    expect(tokens.get(zeroAddress)?.logoURI).toBe('https://logos.example/weth.png')
  })

  it('keeps a native logo the list already provides', () => {
    const listed: TokenListEntry = { chainId: 1, address: zeroAddress, name: 'Ether', symbol: 'ETH', decimals: 18, logoURI: 'https://logos.example/eth.png' }
    const tokens = withNativeTokenEntry(byAddress([WETH, listed]), 1, ETH)

    expect(tokens.get(zeroAddress)?.logoURI).toBe('https://logos.example/eth.png')
  })

  it('omits the logo when the wrapped native has none', () => {
    const { logoURI: _logo, ...unlogged } = WETH
    const tokens = withNativeTokenEntry(byAddress([unlogged]), 1, ETH)

    expect(tokens.get(zeroAddress)).not.toHaveProperty('logoURI')
  })

  it('drops the native coin when the wrapped native is not in the list', () => {
    const listed: TokenListEntry = { chainId: 1, address: zeroAddress, name: 'Ether', symbol: 'ETH', decimals: 18 }
    const tokens = withNativeTokenEntry(byAddress([listed]), 1, ETH)

    expect(tokens.has(zeroAddress)).toBe(false)
  })

  it('does not change the map it was given', () => {
    const input = byAddress([WETH])
    withNativeTokenEntry(input, 1, ETH)

    expect(input.has(zeroAddress)).toBe(false)
  })
})
