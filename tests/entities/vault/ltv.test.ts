import { describe, it, expect } from 'vitest'
import { isLiveCollateralEdge } from '~/entities/vault/ltv'
import type { EVaultCollateral } from '~/entities/vault/types'

const makeEdge = (overrides: Partial<EVaultCollateral> = {}): EVaultCollateral => ({
  address: '0x0000000000000000000000000000000000000001',
  borrowLTV: 0.75,
  liquidationLTV: 0.8,
  currentLiquidationLTV: 0.8,
  isLiquidationLTVRamping: false,
  rampTimeRemaining: 0n,
  oraclePriceRaw: {
    queryFailure: true,
    queryFailureReason: '0x',
    amountIn: 0n,
    amountOutMid: 0n,
    amountOutBid: 0n,
    amountOutAsk: 0n,
    timestamp: 0,
  },
  ...overrides,
})

describe('isLiveCollateralEdge', () => {
  it('is live when borrowLTV is non-zero', () => {
    expect(isLiveCollateralEdge(makeEdge({ borrowLTV: 0.75, currentLiquidationLTV: 0 }))).toBe(true)
  })

  it('is live mid-ramp when borrowLTV is zero but current liquidation LTV is non-zero', () => {
    expect(isLiveCollateralEdge(makeEdge({ borrowLTV: 0, liquidationLTV: 0, currentLiquidationLTV: 0.45 }))).toBe(true)
  })

  it('is not live once both borrowLTV and current liquidation LTV are zero', () => {
    expect(isLiveCollateralEdge(makeEdge({ borrowLTV: 0, liquidationLTV: 0, currentLiquidationLTV: 0 }))).toBe(false)
  })
})
