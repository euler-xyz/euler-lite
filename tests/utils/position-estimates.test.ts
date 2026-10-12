import { afterEach, expect, it, vi } from 'vitest'
import type { PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { estimatePositionAfterChange, getTotalCollateralValue } from '~/utils/position-estimates'

afterEach(() => vi.unstubAllGlobals())
it.each([0, 6, 17])('projects debt in %i asset decimals independently of 18 share decimals', (decimals) => {
  vi.stubGlobal('getBorrowPositionEffectiveLiquidationLTV', () => 0.8)
  const position = {
    borrowed: 2_000n * 10n ** BigInt(decimals),
    userLTV: 2n * 10n ** 17n,
    borrowVault: { asset: { decimals }, shares: { decimals: 18 } },
  } as PortfolioBorrowPosition<VaultEntity>
  expect(getTotalCollateralValue(position)).toBe(10_000)
  expect(estimatePositionAfterChange({ position, borrowDelta: -500 })).toMatchObject({ newLtv: 15, newHealth: 80 / 15 })
})
