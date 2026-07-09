import { describe, expect, it } from 'vitest'
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import {
  formatLiquidationBonusRange,
  getMaxLiquidationDiscountDisplayPercent,
} from '~/utils/vault/liquidation'

const makeVault = (maxLiquidationDiscount: number): Pick<EVault, 'liquidation'> => ({
  liquidation: {
    maxLiquidationDiscount,
    liquidationCoolOffTime: 0,
    socializeDebt: false,
  },
})

describe('liquidation display helpers', () => {
  it('formats fractional max liquidation discounts without float noise', () => {
    const vault = makeVault(0.035)

    expect(getMaxLiquidationDiscountDisplayPercent(vault)).toBeCloseTo(3.5)
    expect(formatLiquidationBonusRange(vault)).toBe('0-3.5%')
  })

  it('preserves whole-percent discounts', () => {
    expect(formatLiquidationBonusRange(makeVault(0.15))).toBe('0-15%')
  })

  it('preserves half-percent discounts', () => {
    expect(formatLiquidationBonusRange(makeVault(0.105))).toBe('0-10.5%')
  })
})
