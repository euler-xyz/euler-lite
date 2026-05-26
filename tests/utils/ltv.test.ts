import { describe, expect, it } from 'vitest'
import type { PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import {
  getBorrowPositionEffectiveLiquidationLTV,
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

  it('preserves unavailable liquidation LTV as undefined', () => {
    const position = makePosition({})

    expect(getBorrowPositionEffectiveLiquidationLTV(position)).toBeUndefined()
  })
})
