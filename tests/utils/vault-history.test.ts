import { describe, expect, it } from 'vitest'

import {
  buildEarnVaultTotalsHistoryPath,
  buildVaultTotalsHistoryPath,
  getVaultHistoryTimeRange,
  hasFiniteCap,
  parseVaultTotalsHistory,
} from '~/utils/vault-history'
import { maxUint256 } from 'viem'

describe('vault history utilities', () => {
  it('parses V3 vault totals history into display units', () => {
    const points = parseVaultTotalsHistory({
      data: {
        history: [
          {
            timestamp: '2026-07-01T00:00:00.000Z',
            totalAssets: '123450000',
            totalAssetsUsd: 123.45,
            totalBorrows: '1000000',
            totalBorrowsUsd: 1,
            cash: '122450000',
            cashUsd: 122.45,
            utilization: 0.25,
            supplyApy: 4.5,
            borrowApy: 6.75,
            sharePrice: 1.01,
          },
        ],
      },
    }, 6)

    expect(points).toEqual([
      {
        timestamp: '2026-07-01T00:00:00.000Z',
        totalAssets: 123.45,
        totalAssetsUsd: 123.45,
        totalBorrows: 1,
        totalBorrowsUsd: 1,
        cash: 122.45,
        cashUsd: 122.45,
        utilization: 0.25,
        supplyApy: 4.5,
        borrowApy: 6.75,
        sharePrice: 1.01,
      },
    ])
  })

  it('preserves nullable numeric history fields', () => {
    const points = parseVaultTotalsHistory({
      data: {
        history: [
          {
            timestamp: '2026-07-01T00:00:00.000Z',
            totalAssets: '123450000',
            totalBorrows: '1000000',
            cash: '122450000',
            utilization: null,
            supplyApy: null,
            borrowApy: null,
          },
        ],
      },
    }, 6)

    expect(points).toEqual([
      {
        timestamp: '2026-07-01T00:00:00.000Z',
        totalAssets: 123.45,
        totalAssetsUsd: null,
        totalBorrows: 1,
        totalBorrowsUsd: null,
        cash: 122.45,
        cashUsd: null,
        utilization: null,
        supplyApy: null,
        borrowApy: null,
        sharePrice: null,
      },
    ])
  })

  it('parses earn totals history points into display units', () => {
    const points = parseVaultTotalsHistory({
      data: {
        history: [
          {
            timestamp: '2026-07-01T00:00:00.000Z',
            totalAssets: '123450000',
            totalAssetsUsd: 123.4,
            sharePrice: 1.02,
            apy: 11.3,
          },
        ],
      },
    }, 6)

    expect(points).toEqual([
      {
        timestamp: '2026-07-01T00:00:00.000Z',
        totalAssets: 123.45,
        totalAssetsUsd: 123.4,
        totalBorrows: null,
        totalBorrowsUsd: null,
        cash: null,
        cashUsd: null,
        utilization: null,
        supplyApy: 11.3,
        borrowApy: null,
        sharePrice: 1.02,
      },
    ])
  })

  it('builds a bounded totals-history URL', () => {
    expect(buildVaultTotalsHistoryPath(
      1,
      '0x797DD80692c3b2dAdabCe8e30C07fDE5307D48a9',
      '7d',
      1_782_984_800_000,
    )).toBe('/api/v3/evk/vaults/1/0x797DD80692c3b2dAdabCe8e30C07fDE5307D48a9/totals?resolution=1d&from=1782345600&to=1782950400')
  })

  it('builds a bounded earn totals-history URL', () => {
    expect(buildEarnVaultTotalsHistoryPath(
      1,
      '0x018b86A893F57a632F90c4A8308353Ac938adc01',
      '7d',
      1_782_984_800_000,
    )).toBe('/api/v3/earn/vaults/1/0x018b86A893F57a632F90c4A8308353Ac938adc01/totals?resolution=1d&from=1782345600&to=1782950400')
  })

  it('returns the same bounded range used by the totals-history URL', () => {
    expect(getVaultHistoryTimeRange('90d', 1_782_984_800_000)).toEqual({
      from: 1775174400,
      to: 1782950400,
    })
  })

  it('identifies finite cap values', () => {
    expect(hasFiniteCap(1n)).toBe(true)
    expect(hasFiniteCap(0n)).toBe(false)
    expect(hasFiniteCap(maxUint256)).toBe(false)
  })
})
