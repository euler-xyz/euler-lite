import { describe, expect, it } from 'vitest'
import { filterSelectableTokens, sortSelectableTokens, type SelectableToken } from '~/utils/token-selector'

const tok = (over: Partial<SelectableToken> & { asset?: Partial<SelectableToken['asset']> } = {}): SelectableToken => ({
  balance: 0n,
  balanceFormatted: 0,
  source: 'tokenList',
  ...over,
  asset: {
    symbol: 'TKN',
    name: 'Token',
    address: '0x0000000000000000000000000000000000000000',
    ...over.asset,
  },
})

const vaultAsset = tok({ source: 'vault', asset: { symbol: 'USDC', name: 'USD Coin', address: '0xUSDC' } })
const held = tok({ source: 'tokenList', balance: 5n, balanceFormatted: 5, asset: { symbol: 'HELD', name: 'Held Token', address: '0xHELD' } })
const spam = tok({ source: 'tokenList', asset: { symbol: 'SPROUT', name: 'Sprout', address: '0xSPROUT' } })

const all = [vaultAsset, held, spam]

describe('filterSelectableTokens', () => {
  it('input mode without search shows the full list (nothing hidden)', () => {
    expect(filterSelectableTokens(all, 'input', '')).toEqual(all)
  })

  it('output mode without search shows the full list (nothing hidden)', () => {
    expect(filterSelectableTokens(all, 'output', '')).toEqual(all)
  })

  it('searching reaches the full list regardless of mode or balance', () => {
    expect(filterSelectableTokens(all, 'output', 'sprout')).toEqual([spam])
    expect(filterSelectableTokens(all, 'input', 'sprout')).toEqual([spam])
  })

  it('search matches symbol, name, or address, case-insensitively', () => {
    expect(filterSelectableTokens(all, 'output', 'USD COIN')).toEqual([vaultAsset])
    expect(filterSelectableTokens(all, 'output', '0xheld')).toEqual([held])
  })

  it('treats a whitespace-only query as no search', () => {
    expect(filterSelectableTokens(all, 'output', '   ')).toEqual(all)
  })
})

describe('sortSelectableTokens', () => {
  it('bubbles held tokens (by amount desc), then Euler vault assets, then the rest alphabetically', () => {
    const held5 = tok({ balance: 5n, balanceFormatted: 5, asset: { symbol: 'ZZZ', name: 'Z', address: '0x1' } })
    const held10 = tok({ balance: 10n, balanceFormatted: 10, asset: { symbol: 'AAA', name: 'A', address: '0x2' } })
    const vault0 = tok({ source: 'vault', asset: { symbol: 'WETH', name: 'Wrapped Ether', address: '0x3' } })
    const otherB = tok({ asset: { symbol: 'BBB', name: 'B', address: '0x4' } })
    const otherA = tok({ asset: { symbol: 'AAB', name: 'A2', address: '0x5' } })

    const sorted = sortSelectableTokens([otherB, vault0, held5, otherA, held10])

    expect(sorted.map(t => t.asset.symbol)).toEqual(['AAA', 'ZZZ', 'WETH', 'AAB', 'BBB'])
  })

  it('orders held tokens by amount (balanceFormatted), not raw bigint balance', () => {
    // 1 ETH (18 decimals) has a far larger raw balance than 5 USDC (6 decimals),
    // but the larger *amount* (5 USDC) must rank first.
    const oneEth = tok({ balance: 10n ** 18n, balanceFormatted: 1, asset: { symbol: 'ETH', name: 'Ether', address: '0xeth' } })
    const fiveUsdc = tok({ balance: 5_000_000n, balanceFormatted: 5, asset: { symbol: 'USDC', name: 'USD Coin', address: '0xusdc' } })

    const sorted = sortSelectableTokens([oneEth, fiveUsdc])

    expect(sorted.map(t => t.asset.symbol)).toEqual(['USDC', 'ETH'])
  })

  it('does not mutate the input array', () => {
    const input = [spam, held]
    const snapshot = [...input]
    sortSelectableTokens(input)
    expect(input).toEqual(snapshot)
  })
})
