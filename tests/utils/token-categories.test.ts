import { describe, expect, it } from 'vitest'
import {
  areTokenAddressesInSameCorrelatedCategory,
  areTokenAddressesCorrelatedByTags,
  normalizeTokenCategoryTags,
  shareCommonTokenCategory,
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

  it('requires one shared allowlisted category across a whole token set', () => {
    expect(shareCommonTokenCategory([['usd', 'eth'], ['usd'], ['USD']])).toBe(true)
    expect(shareCommonTokenCategory([['usd', 'eth'], ['usd'], ['eth']])).toBe(false)
    expect(shareCommonTokenCategory([['usd'], ['other'], ['usd']])).toBe(false)
    expect(shareCommonTokenCategory([['usd']])).toBe(false)
  })

  it('compares addresses through a tag resolver', () => {
    const tags = new Map<string, string[]>([
      ['0x0000000000000000000000000000000000000001', ['usd']],
      ['0x0000000000000000000000000000000000000002', ['USD']],
      ['0x0000000000000000000000000000000000000003', ['other']],
      ['0x0000000000000000000000000000000000000004', ['usd', 'eth']],
      ['0x0000000000000000000000000000000000000005', ['eth']],
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
    expect(
      areTokenAddressesInSameCorrelatedCategory(
        [
          '0x0000000000000000000000000000000000000001',
          '0x0000000000000000000000000000000000000002',
          '0x0000000000000000000000000000000000000004',
        ],
        getTags,
      ),
    ).toBe(true)
    expect(
      areTokenAddressesInSameCorrelatedCategory(
        [
          '0x0000000000000000000000000000000000000001',
          '0x0000000000000000000000000000000000000005',
          '0x0000000000000000000000000000000000000004',
        ],
        getTags,
      ),
    ).toBe(false)
  })

  it('treats an all-same address set as correlated even without category tags', () => {
    expect(
      areTokenAddressesInSameCorrelatedCategory(
        [
          '0x0000000000000000000000000000000000000001',
          '0x0000000000000000000000000000000000000001',
        ],
        () => undefined,
      ),
    ).toBe(true)
  })

  it('fails closed when any address in a set is missing', () => {
    expect(
      areTokenAddressesInSameCorrelatedCategory(
        [
          '0x0000000000000000000000000000000000000001',
          undefined,
          '0x0000000000000000000000000000000000000002',
        ],
        () => ['usd'],
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
