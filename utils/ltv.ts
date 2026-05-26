import type { PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { TTL_INFINITY, TTL_LIQUIDATION, TTL_MORE_THAN_ONE_YEAR } from '~/entities/constants'

export const decimalLtvToBps = (ltv: number | undefined): bigint =>
  ltv === undefined ? 0n : BigInt(Math.round(ltv * 10_000))

export const getBorrowPositionEffectiveLiquidationLTV = (position: PortfolioBorrowPosition<VaultEntity>): number | undefined =>
  position.accountLiquidationLTV ?? position.liquidationLTV

export const getBorrowPositionTimeToLiquidation = (position: PortfolioBorrowPosition<VaultEntity>): bigint => {
  const ttl = position.timeToLiquidation
  if (ttl === 'Infinity' || ttl === undefined) return TTL_INFINITY
  if (ttl === 'MoreThanAYear') return TTL_MORE_THAN_ONE_YEAR
  if (!Number.isFinite(ttl)) return TTL_INFINITY
  if (ttl < 0) return TTL_LIQUIDATION
  return BigInt(Math.floor(ttl))
}
