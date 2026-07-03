import { describe, expect, it } from 'vitest'

import {
  buildVaultTotalsHistoryPath,
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
            totalBorrows: '1000000',
            cash: '122450000',
            utilization: 0.25,
            supplyApy: 4.5,
            borrowApy: 6.75,
          },
        ],
      },
    }, 6)

    expect(points).toEqual([
      {
        timestamp: '2026-07-01T00:00:00.000Z',
        totalAssets: 123.45,
        totalBorrows: 1,
        cash: 122.45,
        utilization: 0.25,
        supplyApy: 4.5,
        borrowApy: 6.75,
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
        totalBorrows: 1,
        cash: 122.45,
        utilization: null,
        supplyApy: null,
        borrowApy: null,
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

  it('identifies finite cap values', () => {
    expect(hasFiniteCap(1n)).toBe(true)
    expect(hasFiniteCap(0n)).toBe(false)
    expect(hasFiniteCap(maxUint256)).toBe(false)
  })
})
