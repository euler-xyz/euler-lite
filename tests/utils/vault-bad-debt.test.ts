import { describe, expect, it } from 'vitest'
import {
  buildBadDebtCache,
  formatBadDebtHint,
  formatBadDebtOverview,
  parseBadDebtResponse,
  type V3VaultBadDebtRow,
} from '~/utils/vault-bad-debt'

const row = (overrides: Partial<V3VaultBadDebtRow> = {}): V3VaultBadDebtRow => ({
  chainId: 1,
  borrowVault: '0x481D4909D7ca2eb27c4975f08dCE07DBeF0d3Fa7',
  borrowAsset: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48',
  accountCount: 2,
  debtUsd: 200,
  collateralUsd: 50,
  coveredDebtUsd: 50,
  badDebtUsd: 150,
  calculationTimestamp: '2026-06-25T10:14:59.000Z',
  priceTimestamp: '2026-06-25T10:14:24.994Z',
  refreshedAt: '2026-06-25T10:15:08.039Z',
  ...overrides,
})

describe('vault bad debt helpers', () => {
  it('normalizes v3 rows into an address keyed cache', () => {
    const cache = buildBadDebtCache([row()])
    const entry = cache.get('0x481d4909d7ca2eb27c4975f08dce07dbef0d3fa7')

    expect(entry?.badDebtUsd).toBe(150)
    expect(entry?.accountCount).toBe(2)
  })

  it('parses malformed v3 responses as empty data', () => {
    expect(parseBadDebtResponse(null)).toEqual([])
    expect(parseBadDebtResponse('')).toEqual([])
    expect(parseBadDebtResponse({})).toEqual([])
    expect(parseBadDebtResponse({ data: [row()] })).toHaveLength(1)
  })

  it('states bad debt as a labelled share of supply, with the share of borrows on the side', () => {
    const entry = buildBadDebtCache([row({ badDebtUsd: 125 })]).values().next().value!

    expect(formatBadDebtOverview(entry, { supplyUsd: 1000, borrowsUsd: 500 })).toEqual({ value: '$125 (12.5% of supply)', borrowShare: '25% of borrows' })
    expect(formatBadDebtHint(entry, { supplyUsd: 1000, borrowsUsd: 500 })).toContain('12.5% of supply - 25% of borrows')
  })

  it('reads eUSDC-42 as 83.2% of supply and 99.99% of borrows', () => {
    const entry = buildBadDebtCache([row({ badDebtUsd: 17_556 })]).values().next().value!

    expect(formatBadDebtOverview(entry, { supplyUsd: 21_100, borrowsUsd: 17_558 })).toEqual({ value: '$17.56K (83.2% of supply)', borrowShare: '99.99% of borrows' })
  })

  it.each([undefined, 0])('prints the amount alone when supply is %s', (supplyUsd) => {
    const entry = buildBadDebtCache([row({ badDebtUsd: 125 })]).values().next().value!

    expect(formatBadDebtOverview(entry, { supplyUsd, borrowsUsd: undefined })).toEqual({ value: '$125', borrowShare: undefined })
    expect(formatBadDebtHint(entry, { supplyUsd, borrowsUsd: undefined })).not.toMatch(/%/)
  })

  it('reports bad debt in positions with unpriced collateral without attributing its cause', () => {
    const entry = buildBadDebtCache([row({ unpricedBadDebtUsd: 40, unpricedCollateralCount: 3 })]).values().next().value!

    expect(entry.pricing).toEqual({ status: 'reported', unpricedUsd: 40, unpricedCollateralCount: 3 })
    expect(formatBadDebtHint(entry, { supplyUsd: 1000, borrowsUsd: 500 })).toContain('$40 bad debt in positions with unpriced collateral (3 unpriced collateral positions valued at $0)')
  })

  it('names one collateral position in the singular', () => {
    const entry = buildBadDebtCache([row({ unpricedBadDebtUsd: 40, unpricedCollateralCount: 1 })]).values().next().value!

    expect(formatBadDebtHint(entry, { supplyUsd: 1000, borrowsUsd: 500 })).toContain('$40 bad debt in positions with unpriced collateral (1 unpriced collateral position valued at $0)')
  })

  it('treats a reported zero as fully priced', () => {
    const entry = buildBadDebtCache([row({ unpricedBadDebtUsd: 0, unpricedCollateralCount: 0 })]).values().next().value!

    expect(entry.pricing).toEqual({ status: 'reported', unpricedUsd: 0, unpricedCollateralCount: 0 })
    expect(formatBadDebtHint(entry, { supplyUsd: 1000, borrowsUsd: 500 })).toContain('all collateral priced')
  })

  it('says unpriced collateral was not reported when the fields are missing or null', () => {
    const missingBoth = buildBadDebtCache([row()]).values().next().value!
    const missingCount = buildBadDebtCache([row({ unpricedBadDebtUsd: 0 })]).values().next().value!
    const nullBoth = buildBadDebtCache([row({ unpricedBadDebtUsd: null, unpricedCollateralCount: null })]).values().next().value!

    expect(missingBoth.pricing).toEqual({ status: 'not-reported' })
    expect(missingCount.pricing).toEqual({ status: 'not-reported' })
    expect(nullBoth.pricing).toEqual({ status: 'not-reported' })
    expect(formatBadDebtHint(missingBoth, { supplyUsd: 1000, borrowsUsd: 500 })).toContain('no data on unpriced collateral')
    expect(formatBadDebtHint(missingBoth, { supplyUsd: 1000, borrowsUsd: 500 })).not.toContain('all collateral priced')
  })

  it('marks inconsistent price coverage as invalid without dropping the bad debt', () => {
    const cases = [
      row({ unpricedBadDebtUsd: 150.01, unpricedCollateralCount: 1 }),
      row({ unpricedBadDebtUsd: -1, unpricedCollateralCount: 1 }),
      row({ unpricedBadDebtUsd: Number.NaN, unpricedCollateralCount: 1 }),
      row({ unpricedBadDebtUsd: 10, unpricedCollateralCount: 1.5 }),
      row({ unpricedBadDebtUsd: 10, unpricedCollateralCount: -1 }),
      row({ unpricedBadDebtUsd: '10' as unknown as number, unpricedCollateralCount: 1 }),
      row({ unpricedBadDebtUsd: 40, unpricedCollateralCount: 0 }),
      row({ unpricedBadDebtUsd: 0, unpricedCollateralCount: 2 }),
    ]
    for (const input of cases) {
      const entry = buildBadDebtCache([input]).values().next().value!
      expect(entry.badDebtUsd).toBe(150)
      expect(entry.pricing).toEqual({ status: 'invalid' })
      expect(formatBadDebtHint(entry, { supplyUsd: 1000, borrowsUsd: 500 })).toContain('unpriced collateral data is invalid')
    }
  })

  it('accepts float dust above the bad debt as reported', () => {
    const entry = buildBadDebtCache([row({ unpricedBadDebtUsd: 150 + 1e-12, unpricedCollateralCount: 2 })]).values().next().value!

    expect(entry.pricing.status).toBe('reported')
  })
})
