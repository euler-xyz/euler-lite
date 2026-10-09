import { describe, expect, it } from 'vitest'
import type { PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { getTotalCollateralValue } from '~/utils/position-estimates'

const makePosition = (borrowed: bigint, shareDecimals = 18) => ({
  borrowed,
  userLTV: 2n * 10n ** 17n,
  borrowVault: { shares: { decimals: shareDecimals } },
} as unknown as PortfolioBorrowPosition<VaultEntity>)

describe('getTotalCollateralValue', () => {
  it('reads the debt in the borrow vault share decimals by default', () => {
    expect(getTotalCollateralValue(makePosition(2_000n * 10n ** 18n))).toBeCloseTo(10_000)
    expect(getTotalCollateralValue(makePosition(2_000n * 10n ** 6n, 6))).toBeCloseTo(10_000)
  })

  it('reads the debt in caller-supplied verified decimals when cached share decimals are stale', () => {
    expect(getTotalCollateralValue(makePosition(2_000n * 10n ** 17n), 17)).toBeCloseTo(10_000)
    expect(getTotalCollateralValue(makePosition(2_000n * 10n ** 6n), 6)).toBeCloseTo(10_000)
    expect(getTotalCollateralValue(makePosition(2_000n * 10n ** 6n), 6n)).toBeCloseTo(10_000)
    // Without the override the stale 18 share decimals shrink the collateral value by the gap.
    expect(getTotalCollateralValue(makePosition(2_000n * 10n ** 17n))).toBeCloseTo(1_000)
  })

  it('returns null without a positive debt or LTV', () => {
    expect(getTotalCollateralValue(makePosition(0n))).toBeNull()
    expect(getTotalCollateralValue({ ...makePosition(1n), userLTV: undefined } as PortfolioBorrowPosition<VaultEntity>)).toBeNull()
  })
})
