import { describe, it, expect } from 'vitest'
import {
  computeMaxMultiplier,
  computeMinMultiplier,
  computeWeightedSupplyApy,
  computeLeverageDebt,
} from '~/utils/multiply-math'

describe('computeMaxMultiplier', () => {
  it('returns 1 for LTV 0%', () => {
    expect(computeMaxMultiplier(0)).toBe(1)
  })

  it('uses the SDK safety margin for LTV 50%', () => {
    expect(computeMaxMultiplier(50)).toBe(1.99)
  })

  it('uses the SDK safety margin for LTV 80%', () => {
    expect(computeMaxMultiplier(80)).toBe(4.99)
  })

  it('uses the SDK safety margin for LTV 90%', () => {
    expect(computeMaxMultiplier(90)).toBe(9.99)
  })

  it('returns 1 for LTV >= 99%', () => {
    expect(computeMaxMultiplier(99)).toBe(1)
    expect(computeMaxMultiplier(100)).toBe(1)
  })

  it('returns 1 for negative LTV', () => {
    expect(computeMaxMultiplier(-10)).toBe(1)
  })

  it('returns 1 for NaN', () => {
    expect(computeMaxMultiplier(NaN)).toBe(1)
  })

  it('returns 1 for Infinity', () => {
    expect(computeMaxMultiplier(Infinity)).toBe(1)
  })

  it('floors to 2 decimal places after applying the safety margin', () => {
    // LTV 75% -> 1/(1-0.75) - 0.005 = 3.995, floored to 3.99.
    expect(computeMaxMultiplier(75)).toBe(3.99)
    // LTV 60% -> 1/(1-0.6) - 0.005 = 2.495, floored to 2.49.
    expect(computeMaxMultiplier(60)).toBe(2.49)
  })

  it('does not round non-tenth max multipliers up', () => {
    expect(computeMaxMultiplier(83)).toBe(5.87)
  })

  it('handles very small LTV', () => {
    // LTV 0.01% → 1/(1-0.0001) ≈ 1.0001, floor to 2dp = 1
    expect(computeMaxMultiplier(0.01)).toBe(1)
  })

  it('handles LTV just below 99%', () => {
    // LTV 98% -> 1/(1-0.98) - 0.005 = 49.995, floored to 49.99.
    expect(computeMaxMultiplier(98)).toBe(49.99)
  })
})

describe('computeMinMultiplier', () => {
  it('returns 0 when max is 1 or less', () => {
    expect(computeMinMultiplier(1)).toBe(0)
    expect(computeMinMultiplier(0)).toBe(0)
    expect(computeMinMultiplier(0.5)).toBe(0)
  })

  it('returns 1 when max is greater than 1', () => {
    expect(computeMinMultiplier(2)).toBe(1)
    expect(computeMinMultiplier(10)).toBe(1)
  })

  it('returns 0 for negative max', () => {
    expect(computeMinMultiplier(-5)).toBe(0)
  })
})

describe('computeWeightedSupplyApy', () => {
  it('returns supplyApy when longUsd is null', () => {
    expect(computeWeightedSupplyApy(100, 0.05, null, 0.03)).toBe(0.05)
  })

  it('returns supplyApy when longUsd is zero', () => {
    expect(computeWeightedSupplyApy(100, 0.05, 0, 0.03)).toBe(0.05)
  })

  it('returns supplyApy when longApy is null', () => {
    expect(computeWeightedSupplyApy(100, 0.05, 50, null)).toBe(0.05)
  })

  it('returns null when total is zero', () => {
    expect(computeWeightedSupplyApy(0, 0.05, 0, 0.03)).toBe(0.05)
  })

  it('calculates weighted average correctly', () => {
    // supply=100 at 5%, long=100 at 3% → (100*0.05 + 100*0.03) / 200 = 0.04
    expect(computeWeightedSupplyApy(100, 0.05, 100, 0.03)).toBeCloseTo(0.04, 6)
  })

  it('weights by USD value', () => {
    // (300*0.1 + 100*0.02) / 400 = (30 + 2) / 400 = 0.08
    expect(computeWeightedSupplyApy(300, 0.1, 100, 0.02)).toBeCloseTo(0.08, 6)
  })

  it('returns null when total is zero or negative', () => {
    // supplyUsd=-100, longUsd=50 (longUsd>0 so passes first check), total=-50 <= 0
    expect(computeWeightedSupplyApy(-100, 0.05, 50, 0.03)).toBeNull()
  })

  it('returns null when total is non-finite', () => {
    expect(computeWeightedSupplyApy(Infinity, 0.05, 100, 0.03)).toBeNull()
  })
})

describe('computeLeverageDebt', () => {
  it('returns 0n when collateralAmountIn is zero', () => {
    expect(computeLeverageDebt({
      suppliedCollateral: 1000n,
      collateralOutBid: 2000n,
      collateralAmountIn: 0n,
      multiplier: 2,
      liabilityIn: 1000n,
      liabilityOutAsk: 1000n,
    })).toBe(0n)
  })

  it('returns 0n when liabilityOutAsk is zero', () => {
    expect(computeLeverageDebt({
      suppliedCollateral: 1000n,
      collateralOutBid: 2000n,
      collateralAmountIn: 1000n,
      multiplier: 2,
      liabilityIn: 1000n,
      liabilityOutAsk: 0n,
    })).toBe(0n)
  })

  it('returns 0n when multiplier is 1 or less', () => {
    expect(computeLeverageDebt({
      suppliedCollateral: 1000n,
      collateralOutBid: 2000n,
      collateralAmountIn: 1000n,
      multiplier: 1,
      liabilityIn: 1000n,
      liabilityOutAsk: 1000n,
    })).toBe(0n)

    expect(computeLeverageDebt({
      suppliedCollateral: 1000n,
      collateralOutBid: 2000n,
      collateralAmountIn: 1000n,
      multiplier: 0.5,
      liabilityIn: 1000n,
      liabilityOutAsk: 1000n,
    })).toBe(0n)
  })

  it('calculates debt for 2x leverage with 1:1 prices', () => {
    // supplied=1000, collateral price=1:1, multiplier=2, liability price=1:1
    // suppliedValue = (1000 * 1000) / 1000 = 1000
    // scaledMultiple = 2000
    // multiplied = (1000 * 2000) / 1000 = 2000
    // debt value = 2000 - 1000 = 1000
    // debt amount = (1000 * 1000) / 1000 = 1000
    expect(computeLeverageDebt({
      suppliedCollateral: 1000n,
      collateralOutBid: 1000n,
      collateralAmountIn: 1000n,
      multiplier: 2,
      liabilityIn: 1000n,
      liabilityOutAsk: 1000n,
    })).toBe(1000n)
  })

  it('calculates debt with different oracle prices', () => {
    // supplied=1_000_000 (1 ETH in 6 decimals?), collateral price bid=2000, amountIn=1
    // suppliedValue = 1_000_000 * 2000 / 1 = 2_000_000_000
    // multiplier=3 → scaledMultiple=3000
    // multiplied = 2_000_000_000 * 3000 / 1000 = 6_000_000_000
    // debtValue = 6_000_000_000 - 2_000_000_000 = 4_000_000_000
    // liability price: in=1, ask=4000
    // debt = 4_000_000_000 * 1 / 4000 = 1_000_000
    expect(computeLeverageDebt({
      suppliedCollateral: 1_000_000n,
      collateralOutBid: 2000n,
      collateralAmountIn: 1n,
      multiplier: 3,
      liabilityIn: 1n,
      liabilityOutAsk: 4000n,
    })).toBe(1_000_000n)
  })

  it('returns 0n when suppliedCollateral is zero', () => {
    expect(computeLeverageDebt({
      suppliedCollateral: 0n,
      collateralOutBid: 2000n,
      collateralAmountIn: 1000n,
      multiplier: 2,
      liabilityIn: 1000n,
      liabilityOutAsk: 1000n,
    })).toBe(0n)
  })

  it('calculates debt for 1.5x leverage (fractional multiplier)', () => {
    // scaledMultiple = floor(1.5 * 1000) = 1500
    // suppliedValue = (1000 * 1000) / 1000 = 1000
    // multiplied = (1000 * 1500) / 1000 = 1500
    // debt = 1500 - 1000 = 500
    expect(computeLeverageDebt({
      suppliedCollateral: 1000n,
      collateralOutBid: 1000n,
      collateralAmountIn: 1000n,
      multiplier: 1.5,
      liabilityIn: 1000n,
      liabilityOutAsk: 1000n,
    })).toBe(500n)
  })
})
