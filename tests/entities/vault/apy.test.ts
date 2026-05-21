import { describe, it, expect } from 'vitest'
import { computeApyFromRateChange, getNetAPY, getRoe } from '~/entities/vault/apy'
import { SECONDS_IN_YEAR } from '~/entities/constants'

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

describe('computeApyFromRateChange', () => {
  // 1e15 keeps Number(priorRate) inside Number.MAX_SAFE_INTEGER so the
  // bigint → Number conversion in the helper preserves precision.
  const PROBE = 10n ** 15n
  const ONE_HOUR = 3600

  // Convert a target APY (decimal, e.g. 0.05 = 5%) into the bigint delta the
  // helper would observe over `elapsedSeconds`, given priorRate = PROBE.
  const deltaForApy = (apy: number, elapsedSeconds: number): bigint => {
    const spy = Math.pow(1 + apy, 1 / SECONDS_IN_YEAR) - 1
    const rateChange = Math.pow(1 + spy, elapsedSeconds) - 1
    return BigInt(Math.round(Number(PROBE) * rateChange))
  }

  it('returns 0 when prior rate is zero', () => {
    expect(computeApyFromRateChange(100n, 0n, ONE_HOUR)).toBe(0)
  })

  it('returns 0 when elapsed seconds is zero or negative', () => {
    expect(computeApyFromRateChange(PROBE + 1000n, PROBE, 0)).toBe(0)
    expect(computeApyFromRateChange(PROBE + 1000n, PROBE, -1)).toBe(0)
  })

  it('returns 0 when both rates are identical', () => {
    expect(computeApyFromRateChange(PROBE, PROBE, ONE_HOUR)).toBe(0)
  })

  it.each([
    { apy: 0.01 },
    { apy: 0.05 },
    { apy: 0.10 },
    { apy: 0.25 },
    { apy: 0.50 },
    { apy: 1.00 },
  ])('round-trips compound APY = $apy from a 1h rate change', ({ apy }) => {
    const delta = deltaForApy(apy, ONE_HOUR)
    const result = computeApyFromRateChange(PROBE + delta, PROBE, ONE_HOUR)
    // 0.5pp tolerance covers integer-rounding of delta at this probe size.
    expect(result).toBeCloseTo(apy * 100, 0)
  })

  it('round-trips a target APY across non-3600s windows', () => {
    // 47 minutes — what a real measurement would look like when the actual
    // timestamp delta differs from the nominal 1h target.
    const elapsed = 47 * 60
    const delta = deltaForApy(0.08, elapsed)
    const result = computeApyFromRateChange(PROBE + delta, PROBE, elapsed)
    expect(result).toBeCloseTo(8, 1)
  })

  it('produces a higher APY than the old linear formula at high yields', () => {
    // Sanity check that we are compounding, not just annualising linearly.
    // 50% APY over 1h: spy ≈ 1.286e-8, 1h rateChange ≈ 4.629e-5.
    // Linear: 4.629e-5 / 3600 * SECONDS_IN_YEAR * 100 ≈ 40.58
    // Compound: ~50.00
    const delta = deltaForApy(0.50, ONE_HOUR)
    const result = computeApyFromRateChange(PROBE + delta, PROBE, ONE_HOUR)
    expect(result).toBeGreaterThan(45)
    expect(result).toBeLessThan(55)
  })

  it('handles negative rate change (vault lost value)', () => {
    const result = computeApyFromRateChange(PROBE - 1_000_000n, PROBE, ONE_HOUR)
    expect(result).toBeLessThan(0)
    expect(Number.isFinite(result)).toBe(true)
  })
})
