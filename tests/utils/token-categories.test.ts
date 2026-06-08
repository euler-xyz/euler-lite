import { describe, expect, it } from 'vitest'
import {
  areTokenAddressesCorrelatedByTags,
  normalizeTokenCategoryTags,
  shareTokenCategory,
} from '~/utils/token-categories'

describe('token category helpers', () => {
  it('normalizes token category tags', () => {
    expect(
      normalizeTokenCategoryTags([' Stablecoin ', 'STABLECOIN', '', 123, 'btc']),
    ).toEqual(['stablecoin', 'btc'])
  })

  it('requires a shared non-other category', () => {
    expect(shareTokenCategory(['stablecoin'], ['Stablecoin'])).toBe(true)
    expect(shareTokenCategory(['other'], ['other'])).toBe(false)
    expect(shareTokenCategory(['stablecoin'], ['eth'])).toBe(false)
    expect(shareTokenCategory(undefined, ['stablecoin'])).toBe(false)
  })

  it('compares addresses through a tag resolver', () => {
    const tags = new Map<string, string[]>([
      ['0x0000000000000000000000000000000000000001', ['stablecoin']],
      ['0x0000000000000000000000000000000000000002', ['STABLECOIN']],
      ['0x0000000000000000000000000000000000000003', ['other']],
    ])
    const getTags = (address: string) => tags.get(address.toLowerCase())

    expect(
      areTokenAddressesCorrelatedByTags(
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000002',
        getTags,
      ),
    ).toBe(true)
    expect(
      areTokenAddressesCorrelatedByTags(
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000003',
        getTags,
      ),
    ).toBe(false)
  })
})
