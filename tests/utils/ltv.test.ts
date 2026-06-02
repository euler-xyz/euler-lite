import { describe, expect, it } from 'vitest'
import type { PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import {
  getBorrowPositionEffectiveLiquidationLTV,
  getBorrowPositionUserLTVPercent,
} from '~/utils/ltv'

const makePosition = (
  overrides: Partial<PortfolioBorrowPosition<VaultEntity>>,
): PortfolioBorrowPosition<VaultEntity> => overrides as PortfolioBorrowPosition<VaultEntity>

describe('borrow position liquidation LTV helpers', () => {
  it('uses account-level liquidation LTV before pair-level liquidation LTV', () => {
    const position = makePosition({
      liquidationLTV: 0.8,
      accountLiquidationLTV: 0.75,
    })

    expect(getBorrowPositionEffectiveLiquidationLTV(position)).toBe(0.75)
  })

  it('falls back to pair-level liquidation LTV when account-level value is unavailable', () => {
    const position = makePosition({
      liquidationLTV: 0.8,
    })

    expect(getBorrowPositionEffectiveLiquidationLTV(position)).toBe(0.8)
  })

  it('preserves zero pair-level liquidation LTV', () => {
    const position = makePosition({
      liquidationLTV: 0,
    })

    expect(getBorrowPositionEffectiveLiquidationLTV(position)).toBe(0)
  })

  it('preserves unavailable liquidation LTV as undefined', () => {
    const position = makePosition({})

    expect(getBorrowPositionEffectiveLiquidationLTV(position)).toBeUndefined()
  })
})

describe('borrow position user LTV helpers', () => {
  it('uses account-level current LTV before fallback state', () => {
    const position = makePosition({
      userLTV: 366500000000000000n,
    })

    expect(getBorrowPositionUserLTVPercent(position)).toBe(36.65)
  })

  it('falls back to current LTV when user LTV is unavailable', () => {
    const position = makePosition({
      currentLTV: 686300000000000000n,
    })

    expect(getBorrowPositionUserLTVPercent(position)).toBe(68.63)
  })

  it('preserves zero user LTV from the SDK', () => {
    const position = makePosition({
      userLTV: 0n,
    })

    expect(getBorrowPositionUserLTVPercent(position)).toBe(0)
  })

  it('preserves unavailable user LTV as undefined', () => {
    const position = makePosition({})

    expect(getBorrowPositionUserLTVPercent(position)).toBeUndefined()
  })
})
