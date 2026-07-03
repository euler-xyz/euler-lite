import { describe, expect, it } from 'vitest'
import {
  buildBadDebtCache,
  formatBadDebtHint,
  formatBadDebtOverviewValue,
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

  it('formats overview values with total-borrow context when available', () => {
    const entry = buildBadDebtCache([row({ badDebtUsd: 125 })]).values().next().value!

    expect(formatBadDebtOverviewValue(entry, 500)).toBe('$125 (25%)')
    expect(formatBadDebtOverviewValue(entry, undefined)).toBe('$125')
    expect(formatBadDebtHint(entry, 500)).toContain('25% of total borrows')
  })
})
