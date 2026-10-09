import { describe, expect, it } from 'vitest'
import { assertSpendingQuoteAsset } from '~/utils/spending-quote'

const asset = { address: '0x00000000000000000000000000000000000000ab', decimals: 8 }
describe('spending quote units', () => {
  it('accepts only the verified address and decimals, case insensitive', () => {
    expect(() => assertSpendingQuoteAsset({ tokenIn: { ...asset, address: asset.address.toUpperCase() } }, asset)).not.toThrow()
  })
  it.each([
    { ...asset, decimals: 18 },
    { ...asset, address: '0x00000000000000000000000000000000000000cd' },
  ])('blocks a quote that disagrees with the verified selection', (tokenIn) => {
    expect(() => assertSpendingQuoteAsset({ tokenIn }, asset)).toThrow('Quote input does not match verified spending asset')
  })
})
