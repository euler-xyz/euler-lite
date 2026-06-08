import { describe, expect, it } from 'vitest'
import {
  areTokenAddressesCorrelatedByTags,
  normalizeTokenCategoryTags,
  shareTokenCategory,
} from '~/utils/token-categories'

describe('token category helpers', () => {
  it('normalizes token category tags', () => {
    expect(
      normalizeTokenCategoryTags([' USD ', 'USD', '', 123, 'btc']),
    ).toEqual(['usd', 'btc'])
  })

  it('requires a shared allowlisted category', () => {
    expect(shareTokenCategory(['usd'], ['USD'])).toBe(true)
    expect(shareTokenCategory(['other'], ['other'])).toBe(false)
    expect(shareTokenCategory(['stablecoin'], ['stablecoin'])).toBe(false)
    expect(shareTokenCategory(['usd'], ['eth'])).toBe(false)
    expect(shareTokenCategory(undefined, ['usd'])).toBe(false)
  })

  it('compares addresses through a tag resolver', () => {
    const tags = new Map<string, string[]>([
      ['0x0000000000000000000000000000000000000001', ['usd']],
      ['0x0000000000000000000000000000000000000002', ['USD']],
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

  it('treats the same token address as correlated even without category tags', () => {
    expect(
      areTokenAddressesCorrelatedByTags(
        '0x0000000000000000000000000000000000000001',
        '0x0000000000000000000000000000000000000001',
        () => undefined,
      ),
    ).toBe(true)
  })
})
