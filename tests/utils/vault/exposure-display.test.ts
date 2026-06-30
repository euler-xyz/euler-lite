import { describe, expect, it } from 'vitest'
import { buildAllocatedVaultExposureDisplayItems } from '~/utils/vault/exposure-display'
import type { CollateralExposureGroup } from '~/utils/vault/collateral-exposure'

const group = (
  symbol: string,
  openInterestUsd: number,
  maxBorrowLTV = 0.86,
): CollateralExposureGroup => ({
  asset: {
    address: `0x${symbol.toLowerCase().padEnd(40, '0')}`,
    symbol,
  },
  items: [],
  vaultCount: 1,
  maxBorrowLTV,
  maxCurrentLiquidationLTV: maxBorrowLTV,
  openInterestUsd,
})

describe('buildAllocatedVaultExposureDisplayItems', () => {
  it('weights utilized exposure by live open-interest split and keeps only the remainder idle', () => {
    const items = buildAllocatedVaultExposureDisplayItems({
      collateralGroups: [
        group('wstETH', 80),
        group('cbBTC', 20),
      ],
      totalExposureUsd: 100,
      idleAsset: { address: '0xweth', symbol: 'WETH' },
      utilization: 90,
    })

    expect(items.find(item => item.asset.symbol === 'wstETH')?.valueUsd).toBeCloseTo(72)
    expect(items.find(item => item.asset.symbol === 'cbBTC')?.valueUsd).toBeCloseTo(18)
    expect(items.find(item => item.label === 'WETH Idle')?.valueUsd).toBeCloseTo(10)
  })

  it('does not infer collateral exposure when the live split is missing', () => {
    const items = buildAllocatedVaultExposureDisplayItems({
      collateralGroups: [group('wstETH', 0)],
      totalExposureUsd: 100,
      idleAsset: { address: '0xweth', symbol: 'WETH' },
      utilization: 99,
    })

    expect(items.find(item => item.asset.symbol === 'wstETH')).toBeUndefined()
    expect(items.find(item => item.label === 'WETH Idle')?.valueUsd).toBeCloseTo(1)
  })
})
