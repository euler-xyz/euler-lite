import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { formatNumber } from '~/utils/string-utils'

export const getMaxLiquidationDiscountDisplayPercent = (
  vault: Pick<EVault, 'liquidation'>,
): number => {
  const discount = vault.liquidation.maxLiquidationDiscount
  if (!Number.isFinite(discount) || discount <= 0) return 0
  return discount * 100
}

export const formatLiquidationBonusRange = (
  vault: Pick<EVault, 'liquidation'>,
): string => `0-${formatNumber(getMaxLiquidationDiscountDisplayPercent(vault), 2, 0)}%`
