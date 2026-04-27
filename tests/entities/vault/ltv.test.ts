import { describe, it, expect } from 'vitest'
import {
  getCurrentLiquidationLTV,
  isLiquidationLTVRamping,
  isLiveCollateralEdge,
  getRampTimeRemaining,
  type CollateralEdgeConfig,
  type LTVRampConfig,
} from '~/entities/vault/ltv'

const makeLtv = (overrides: Partial<LTVRampConfig> = {}): LTVRampConfig => ({
  liquidationLTV: 8000n, // target: 80%
  initialLiquidationLTV: 9000n, // started at 90%
  targetTimestamp: 2000n, // completes at t=2000
  rampDuration: 1000n, // takes 1000 seconds
  ...overrides,
})

const makeEdge = (overrides: Partial<CollateralEdgeConfig> = {}): CollateralEdgeConfig => ({
  ...makeLtv(),
  borrowLTV: 7500n,
  ...overrides,
})

describe('getCurrentLiquidationLTV', () => {
  it('returns target when ramp is complete', () => {
    const ltv = makeLtv()
    // now=3000 > target=2000
    expect(getCurrentLiquidationLTV(ltv, 3000n)).toBe(8000n)
  })

  it('returns target exactly at targetTimestamp', () => {
    const ltv = makeLtv()
    expect(getCurrentLiquidationLTV(ltv, 2000n)).toBe(8000n)
  })

  it('returns target when ramping UP (liquidation >= initial)', () => {
    const ltv = makeLtv({ liquidationLTV: 9500n, initialLiquidationLTV: 9000n })
    expect(getCurrentLiquidationLTV(ltv, 1500n)).toBe(9500n)
  })

  it('returns interpolated value during ramp down at midpoint', () => {
    const ltv = makeLtv()
    // now=1500, target=2000, remaining=500
    // currentLTV = 8000 + ((9000-8000) * 500) / 1000 = 8000 + 500 = 8500
    expect(getCurrentLiquidationLTV(ltv, 1500n)).toBe(8500n)
  })

  it('returns initial at start of ramp', () => {
    const ltv = makeLtv()
    // now=1000 (start), remaining=1000
    // currentLTV = 8000 + ((9000-8000) * 1000) / 1000 = 9000
    expect(getCurrentLiquidationLTV(ltv, 1000n)).toBe(9000n)
  })

  it('returns interpolated value at 25% through ramp', () => {
    const ltv = makeLtv()
    // now=1250, remaining=750
    // currentLTV = 8000 + (1000 * 750) / 1000 = 8750
    expect(getCurrentLiquidationLTV(ltv, 1250n)).toBe(8750n)
  })

  it('caps at initialLiquidationLTV before ramp period starts', () => {
    const ltv = makeLtv()
    // now=500, before ramp starts at t=1000
    // Uncapped formula would give 9500 > initial 9000
    // Capped to initialLiquidationLTV
    expect(getCurrentLiquidationLTV(ltv, 500n)).toBe(9000n)
  })

  it('handles equal liquidation and initial LTV (no ramp)', () => {
    const ltv = makeLtv({ liquidationLTV: 9000n, initialLiquidationLTV: 9000n })
    expect(getCurrentLiquidationLTV(ltv, 1500n)).toBe(9000n)
  })
})

describe('isLiquidationLTVRamping', () => {
  it('returns true when ramping down and before target', () => {
    const ltv = makeLtv()
    expect(isLiquidationLTVRamping(ltv, 1500n)).toBe(true)
  })

  it('returns false when past target timestamp', () => {
    const ltv = makeLtv()
    expect(isLiquidationLTVRamping(ltv, 3000n)).toBe(false)
  })

  it('returns false at target timestamp', () => {
    const ltv = makeLtv()
    expect(isLiquidationLTVRamping(ltv, 2000n)).toBe(false)
  })

  it('returns false when ramping UP', () => {
    const ltv = makeLtv({ liquidationLTV: 9500n, initialLiquidationLTV: 9000n })
    expect(isLiquidationLTVRamping(ltv, 1500n)).toBe(false)
  })

  it('returns false when LTV equals initial (no change)', () => {
    const ltv = makeLtv({ liquidationLTV: 9000n, initialLiquidationLTV: 9000n })
    expect(isLiquidationLTVRamping(ltv, 1500n)).toBe(false)
  })
})

describe('isLiveCollateralEdge', () => {
  it('is live when borrowLTV > 0 and liquidation LTV is non-zero', () => {
    expect(isLiveCollateralEdge(makeEdge(), 1500n)).toBe(true)
  })

  it('is live mid-ramp even when borrowLTV is already 0', () => {
    // The exact case the bug fix addresses: curator started LTV ramp-down,
    // borrowLTV is zeroed immediately, liquidation LTV is still > 0 mid-ramp.
    const edge = makeEdge({ borrowLTV: 0n, liquidationLTV: 0n })
    expect(getCurrentLiquidationLTV(edge, 1500n)).toBeGreaterThan(0n)
    expect(isLiveCollateralEdge(edge, 1500n)).toBe(true)
  })

  it('is not live once both borrowLTV and the ramped liquidation LTV are 0', () => {
    const edge = makeEdge({ borrowLTV: 0n, liquidationLTV: 0n })
    // now=3000 > target=2000 → ramp complete
    expect(isLiveCollateralEdge(edge, 3000n)).toBe(false)
  })

  it('is live when borrowLTV > 0 even after the liquidation ramp has completed at zero', () => {
    // Defensive: shouldn't happen on chain (you can't borrow against a 0 liq
    // LTV), but the predicate is symmetric — borrow alone keeps it live.
    const edge = makeEdge({ borrowLTV: 1n, liquidationLTV: 0n })
    expect(isLiveCollateralEdge(edge, 3000n)).toBe(true)
  })
})

describe('getRampTimeRemaining', () => {
  it('returns time remaining before target', () => {
    const ltv = makeLtv()
    expect(getRampTimeRemaining(ltv, 1500n)).toBe(500n)
  })

  it('returns 0 at target timestamp', () => {
    const ltv = makeLtv()
    expect(getRampTimeRemaining(ltv, 2000n)).toBe(0n)
  })

  it('returns 0 past target timestamp', () => {
    const ltv = makeLtv()
    expect(getRampTimeRemaining(ltv, 3000n)).toBe(0n)
  })
})
