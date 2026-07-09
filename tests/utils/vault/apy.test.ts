import { describe, it, expect } from 'vitest'
import { getNetAPY, getNetAPYFromWeightedSupplySnapshot, getRoe } from '~/utils/vault/apy'

describe('getNetAPY', () => {
  it('returns 0 when supplyUSD is 0', () => {
    expect(getNetAPY(0, 0.05, 100, 0.08)).toBe(0)
  })

  it('calculates net APY without rewards', () => {
    // supply=200 at 5%, borrow=100 at 8%
    // sum = 200*0.05 - 100*0.08 = 10 - 8 = 2
    // netAPY = 2 / 200 = 0.01
    expect(getNetAPY(200, 0.05, 100, 0.08)).toBeCloseTo(0.01, 6)
  })

  it('calculates with supply reward APY', () => {
    // supply=200 at 5% + 2% reward, borrow=100 at 8%
    // sum = 200*(0.05+0.02) - 100*0.08 = 14 - 8 = 6
    // netAPY = 6 / 200 = 0.03
    expect(getNetAPY(200, 0.05, 100, 0.08, 0.02)).toBeCloseTo(0.03, 6)
  })

  it('calculates with borrow reward APY (reduces borrow cost)', () => {
    // supply=200 at 5%, borrow=100 at 8% with 3% reward
    // sum = 200*0.05 - 100*(0.08-0.03) = 10 - 5 = 5
    // netAPY = 5 / 200 = 0.025
    expect(getNetAPY(200, 0.05, 100, 0.08, null, 0.03)).toBeCloseTo(0.025, 6)
  })

  it('calculates with looping reward APY', () => {
    // supply=200 at 5%, borrow=100 at 8%, looping reward 1%
    // equity = 200 - 100 = 100
    // sum = 200*0.05 - 100*0.08 + 100*0.01 = 10 - 8 + 1 = 3
    // netAPY = 3 / 200 = 0.015
    expect(getNetAPY(200, 0.05, 100, 0.08, null, null, 0.01)).toBeCloseTo(0.015, 6)
  })

  it('handles null reward APYs as zero', () => {
    expect(getNetAPY(200, 0.05, 100, 0.08, null, null, null))
      .toBe(getNetAPY(200, 0.05, 100, 0.08))
  })

  it('handles supply-only position (no borrow)', () => {
    // supply=100 at 5%, borrow=0 → netAPY = 5%
    expect(getNetAPY(100, 0.05, 0, 0)).toBeCloseTo(0.05, 6)
  })

  it('does not double-count rewards already included in weighted snapshots', () => {
    const snapshot = {
      supplyUsd: 200,
      weightedSupplyApy: 0.07,
    }

    expect(getNetAPYFromWeightedSupplySnapshot(
      snapshot,
      0.05,
      100,
      0.08,
      0.02,
    )).toBeCloseTo(0.03, 6)
  })

  it('falls back to separate rewards when a weighted snapshot APY is unavailable', () => {
    const snapshot = {
      supplyUsd: 200,
      weightedSupplyApy: null,
    }

    expect(getNetAPYFromWeightedSupplySnapshot(
      snapshot,
      0.05,
      100,
      0.08,
      0.02,
    )).toBeCloseTo(0.03, 6)
  })
})

describe('getRoe', () => {
  it('returns 0 when equity is zero', () => {
    expect(getRoe(100, 0.05, 100, 0.08)).toBe(0)
  })

  it('returns 0 when equity is negative', () => {
    expect(getRoe(50, 0.05, 100, 0.08)).toBe(0)
  })

  it('calculates ROE correctly', () => {
    // supply=200 at 5%, borrow=100 at 8%
    // equity = 100
    // netYield = 200*0.05 - 100*0.08 = 2
    // roe = 2 / 100 = 0.02
    expect(getRoe(200, 0.05, 100, 0.08)).toBeCloseTo(0.02, 6)
  })

  it('calculates ROE with rewards', () => {
    // supply=200 at 5% + 2% reward, borrow=100 at 8% with 1% reward, looping 0.5%
    // equity = 100
    // netYield = 200*(0.05+0.02) - 100*(0.08-0.01) + 100*0.005 = 14 - 7 + 0.5 = 7.5
    // roe = 7.5 / 100 = 0.075
    expect(getRoe(200, 0.05, 100, 0.08, 0.02, 0.01, 0.005)).toBeCloseTo(0.075, 6)
  })

  it('handles supply-only position', () => {
    // supply=100 at 5%, borrow=0 → equity=100, roe = 100*0.05/100 = 0.05
    expect(getRoe(100, 0.05, 0, 0)).toBeCloseTo(0.05, 6)
  })
})
