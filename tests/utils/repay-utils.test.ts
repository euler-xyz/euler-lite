import { describe, it, expect } from 'vitest'
import {
  amountToPercent,
  percentToAmountNano,
  computeNextLtv,
  computeNextHealth,
  computeLiquidationPrice,
} from '~/utils/repayUtils'
import { getRoe } from '~/entities/vault'

describe('amountToPercent', () => {
  it('returns 0 when totalDebt is zero', () => {
    expect(amountToPercent(100n, 0n)).toBe(0)
  })

  it('returns 0 when amount is zero', () => {
    expect(amountToPercent(0n, 1000n)).toBe(0)
  })

  it('returns 0 when amount is negative', () => {
    expect(amountToPercent(-1n, 1000n)).toBe(0)
  })

  it('returns correct percent for partial amount', () => {
    expect(amountToPercent(500n, 1000n)).toBe(50)
  })

  it('returns 100 for full amount', () => {
    expect(amountToPercent(1000n, 1000n)).toBe(100)
  })

  it('caps at 100 for overflow', () => {
    expect(amountToPercent(2000n, 1000n)).toBe(100)
  })

  it('truncates bigint division (floors)', () => {
    // 333 * 100 / 1000 = 33 (bigint truncation), then Math.round(33) = 33
    expect(amountToPercent(333n, 1000n)).toBe(33)
    // 335 * 100 / 1000 = 33 (bigint truncation), then Math.round(33) = 33
    expect(amountToPercent(335n, 1000n)).toBe(33)
    // 336 * 100 / 1000 = 33, Math.round(33) = 33
    expect(amountToPercent(500n, 1000n)).toBe(50)
  })
})

describe('percentToAmountNano', () => {
  it('returns 0n for 0%', () => {
    expect(percentToAmountNano(0, 1000n)).toBe(0n)
  })

  it('returns full amount for 100%', () => {
    expect(percentToAmountNano(100, 1000n)).toBe(1000n)
  })

  it('returns half for 50%', () => {
    expect(percentToAmountNano(50, 1000n)).toBe(500n)
  })

  it('clamps negative to 0', () => {
    expect(percentToAmountNano(-10, 1000n)).toBe(0n)
  })

  it('clamps above 100 to 100', () => {
    expect(percentToAmountNano(150, 1000n)).toBe(1000n)
  })

  it('handles fractional percent', () => {
    expect(percentToAmountNano(33.33, 10000n)).toBe(3333n)
  })

  it('handles NaN as zero', () => {
    expect(percentToAmountNano(NaN, 1000n)).toBe(0n)
  })
})

describe('computeNextLtv', () => {
  it('returns 0 when borrow is zero', () => {
    expect(computeNextLtv(0, 100, 1.5)).toBe(0)
  })

  it('returns null when collateral is zero', () => {
    expect(computeNextLtv(100, 0, 1.5)).toBeNull()
  })

  it('returns null when price is zero', () => {
    expect(computeNextLtv(100, 100, 0)).toBeNull()
  })

  it('returns null when price is negative', () => {
    expect(computeNextLtv(100, 100, -1)).toBeNull()
  })

  it('calculates correct LTV', () => {
    // borrow=75, collateral=100, price=1 → 75%
    expect(computeNextLtv(75, 100, 1)).toBe(75)
  })

  it('calculates with price ratio', () => {
    // borrow=75, collateral=100, price=2 → 75 / (100*2) * 100 = 37.5%
    expect(computeNextLtv(75, 100, 2)).toBe(37.5)
  })

  it('returns null for NaN price', () => {
    expect(computeNextLtv(75, 100, NaN)).toBeNull()
  })

  it('returns null for NaN collateral', () => {
    expect(computeNextLtv(75, NaN, 1)).toBeNull()
  })

  it('returns null for Infinity price', () => {
    expect(computeNextLtv(75, 100, Infinity)).toBeNull()
  })

  it('returns null when collateral is negative', () => {
    expect(computeNextLtv(75, -1, 1)).toBeNull()
  })
})

describe('computeNextHealth', () => {
  it('returns null when liquidationLtv is null', () => {
    expect(computeNextHealth(null, 50)).toBeNull()
  })

  it('returns null when nextLtv is null', () => {
    expect(computeNextHealth(80, null)).toBeNull()
  })

  it('returns Infinity when nextLtv is zero', () => {
    expect(computeNextHealth(80, 0)).toBe(Infinity)
  })

  it('returns Infinity when nextLtv is negative', () => {
    expect(computeNextHealth(80, -5)).toBe(Infinity)
  })

  it('calculates health factor correctly', () => {
    // liquidationLtv=80, nextLtv=40 → health=2.0
    expect(computeNextHealth(80, 40)).toBe(2)
  })

  it('returns health < 1 when over-leveraged', () => {
    // liquidationLtv=80, nextLtv=90 → health=0.888...
    expect(computeNextHealth(80, 90)).toBeCloseTo(0.889, 2)
  })
})

describe('computeLiquidationPrice', () => {
  it('returns null when priceRatio is null', () => {
    expect(computeLiquidationPrice(null, 2)).toBeNull()
  })

  it('returns null when health is null', () => {
    expect(computeLiquidationPrice(1.5, null)).toBeNull()
  })

  it('returns null when priceRatio is zero', () => {
    expect(computeLiquidationPrice(0, 2)).toBeNull()
  })

  it('returns null when health is zero', () => {
    expect(computeLiquidationPrice(1.5, 0)).toBeNull()
  })

  it('calculates liquidation price correctly', () => {
    // price=2000, health=2 → liquidation at 1000
    expect(computeLiquidationPrice(2000, 2)).toBe(1000)
  })

  it('returns null when health is below 1 (position already liquidatable)', () => {
    expect(computeLiquidationPrice(2000, 0.5)).toBeNull()
    expect(computeLiquidationPrice(2000, 0.99)).toBeNull()
  })

  it('returns price at exact health boundary of 1', () => {
    expect(computeLiquidationPrice(2000, 1)).toBe(2000)
  })

  it('returns null when health is NaN', () => {
    expect(computeLiquidationPrice(1.5, NaN)).toBeNull()
  })

  it('returns null when priceRatio is NaN', () => {
    expect(computeLiquidationPrice(NaN, 2)).toBeNull()
  })
})

describe('getRoe', () => {
  it('returns null when any input is null', () => {
    expect(getRoe(null, 0.05, 100, 0.08)).toBeNull()
    expect(getRoe(100, 0.05, null, 0.08)).toBeNull()
    expect(getRoe(100, null, 50, 0.08)).toBeNull()
    expect(getRoe(100, 0.05, 50, null)).toBeNull()
  })

  it('returns 0 when equity is zero', () => {
    expect(getRoe(100, 0.05, 100, 0.08)).toBe(0)
  })

  it('returns 0 when equity is negative', () => {
    expect(getRoe(50, 0.05, 100, 0.08)).toBe(0)
  })

  it('calculates ROE correctly', () => {
    // supply=200, borrow=100, supplyApy=0.05, borrowApy=0.08
    // net = 200*0.05 - 100*0.08 = 10 - 8 = 2
    // equity = 200 - 100 = 100
    // roe = 2/100 = 0.02
    expect(getRoe(200, 0.05, 100, 0.08)).toBeCloseTo(0.02, 6)
  })

  it('returns null for non-finite equity', () => {
    expect(getRoe(Infinity, 0.05, 100, 0.08)).toBeNull()
  })

  it('returns null for non-finite net', () => {
    expect(getRoe(200, Infinity, 100, 0.08)).toBeNull()
  })
})
