import { describe, expect, it } from 'vitest'
import {
  areTokenAddressesInSameCorrelatedCategory,
  areTokenAddressesCorrelatedByTags,
  fromTokenCategoryFilterValue,
  getSharedTokenCategory,
  getSupportedTokenCategoryOptions,
  getTokenAddressesCorrelationCategoryLabel,
  normalizeTokenCategoryTags,
  shareCommonTokenCategory,
  shareTokenCategory,
  toTokenCategoryFilterValue,
  tokenAddressMatchesCategoryFilter,
} from '~/utils/token-categories'

describe('token category helpers', () => {
  it('normalizes token category tags', () => {
    expect(
      normalizeTokenCategoryTags([' USD ', 'USD', '', 123, 'btc']),
    ).toEqual(['usd', 'btc'])
  })

  it('requires a shared allowlisted category', () => {
    expect(shareTokenCategory(['usd'], ['USD'])).toBe(true)
    expect(shareTokenCategory(['mon'], ['MON'])).toBe(true)
    expect(shareTokenCategory(['avax'], ['AVAX'])).toBe(true)
    expect(shareTokenCategory(['hype'], ['HYPE'])).toBe(true)
    expect(shareTokenCategory(['bnb'], ['BNB'])).toBe(true)
    expect(getSharedTokenCategory([['usd'], ['USD']])).toBe('usd')
    expect(shareTokenCategory(['pt'], ['PT'])).toBe(false)
    expect(shareTokenCategory(['other'], ['other'])).toBe(false)
    expect(shareTokenCategory(['stablecoin'], ['stablecoin'])).toBe(false)
    expect(shareTokenCategory(['usd'], ['eth'])).toBe(false)
    expect(shareTokenCategory(undefined, ['usd'])).toBe(false)
  })

  it('builds stable category filter values for allowlisted categories', () => {
    expect(getSupportedTokenCategoryOptions()).toEqual([
      { tag: 'usd', label: 'USD' },
      { tag: 'eth', label: 'ETH' },
      { tag: 'btc', label: 'BTC' },
      { tag: 'mon', label: 'MON' },
      { tag: 'avax', label: 'AVAX' },
      { tag: 'hype', label: 'HYPE' },
      { tag: 'bnb', label: 'BNB' },
      { tag: 'pt', label: 'PT' },
    ])
    expect(toTokenCategoryFilterValue(' USD ')).toBe('category:usd')
    expect(fromTokenCategoryFilterValue('category:usd')).toBe('usd')
    expect(fromTokenCategoryFilterValue('category:pt')).toBe('pt')
    expect(fromTokenCategoryFilterValue('category:stablecoin')).toBeNull()
    expect(fromTokenCategoryFilterValue('0x0000000000000000000000000000000000000001')).toBeNull()
  })

  it('matches token addresses against category filter values', () => {
    const tags = new Map<string, string[]>([
      ['0x0000000000000000000000000000000000000001', ['usd']],
      ['0x0000000000000000000000000000000000000002', ['eth']],
      ['0x0000000000000000000000000000000000000003', ['other']],
      ['0x0000000000000000000000000000000000000004', ['pt']],
    ])
    const getTags = (address: string) => tags.get(address.toLowerCase())

    expect(
      tokenAddressMatchesCategoryFilter(
        '0x0000000000000000000000000000000000000001',
        'category:usd',
        getTags,
      ),
    ).toBe(true)
    expect(
      tokenAddressMatchesCategoryFilter(
        '0x0000000000000000000000000000000000000001',
        'category:eth',
        getTags,
      ),
    ).toBe(false)
    expect(
      tokenAddressMatchesCategoryFilter(
        '0x0000000000000000000000000000000000000003',
        'category:other',
        getTags,
      ),
    ).toBe(false)
    expect(
      tokenAddressMatchesCategoryFilter(
        '0x0000000000000000000000000000000000000004',
        'category:pt',
        getTags,
      ),
    ).toBe(true)
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
      ['0x0000000000000000000000000000000000000006', ['mon']],
      ['0x0000000000000000000000000000000000000007', ['MON']],
      ['0x0000000000000000000000000000000000000008', ['avax']],
      ['0x0000000000000000000000000000000000000009', ['AVAX']],
      ['0x000000000000000000000000000000000000000a', ['hype']],
      ['0x000000000000000000000000000000000000000b', ['HYPE']],
      ['0x000000000000000000000000000000000000000c', ['bnb']],
      ['0x000000000000000000000000000000000000000d', ['BNB']],
      ['0x000000000000000000000000000000000000000e', ['pt']],
      ['0x000000000000000000000000000000000000000f', ['PT']],
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
    expect(
      getTokenAddressesCorrelationCategoryLabel(
        [
          '0x0000000000000000000000000000000000000001',
          '0x0000000000000000000000000000000000000002',
          '0x0000000000000000000000000000000000000004',
        ],
        getTags,
      ),
    ).toBe('USD')
    expect(
      getTokenAddressesCorrelationCategoryLabel(
        [
          '0x0000000000000000000000000000000000000001',
          '0x0000000000000000000000000000000000000005',
          '0x0000000000000000000000000000000000000004',
        ],
        getTags,
      ),
    ).toBeUndefined()
    expect(
      getTokenAddressesCorrelationCategoryLabel(
        [
          '0x0000000000000000000000000000000000000006',
          '0x0000000000000000000000000000000000000007',
        ],
        getTags,
      ),
    ).toBe('MON')
    expect(
      getTokenAddressesCorrelationCategoryLabel(
        [
          '0x0000000000000000000000000000000000000008',
          '0x0000000000000000000000000000000000000009',
        ],
        getTags,
      ),
    ).toBe('AVAX')
    expect(
      getTokenAddressesCorrelationCategoryLabel(
        [
          '0x000000000000000000000000000000000000000a',
          '0x000000000000000000000000000000000000000b',
        ],
        getTags,
      ),
    ).toBe('HYPE')
    expect(
      getTokenAddressesCorrelationCategoryLabel(
        [
          '0x000000000000000000000000000000000000000c',
          '0x000000000000000000000000000000000000000d',
        ],
        getTags,
      ),
    ).toBe('BNB')
    expect(
      areTokenAddressesCorrelatedByTags(
        '0x000000000000000000000000000000000000000e',
        '0x000000000000000000000000000000000000000f',
        getTags,
      ),
    ).toBe(false)
    expect(
      getTokenAddressesCorrelationCategoryLabel(
        [
          '0x000000000000000000000000000000000000000e',
          '0x000000000000000000000000000000000000000f',
        ],
        getTags,
      ),
    ).toBeUndefined()
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
    expect(
      getTokenAddressesCorrelationCategoryLabel(
        [
          '0x0000000000000000000000000000000000000001',
          '0x0000000000000000000000000000000000000001',
        ],
        () => undefined,
      ),
    ).toBeUndefined()
  })
})
