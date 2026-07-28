import type { ActivityLiquidationDisplayDetails } from '~/utils/activity-display'

export const getActivityLiquidationBonusEntry = (
  display: ActivityLiquidationDisplayDetails | null,
) => {
  if (!display?.bonus) return null
  return {
    kind: 'valuation' as const,
    key: 'liquidation-bonus',
    label: 'Liquidator bonus',
    value: display.bonus,
    valueClass: display.bonusTone === 'positive'
      ? 'text-accent-600'
      : display.bonusTone === 'negative'
        ? 'text-error-500'
        : undefined,
    valueTitle: display.bonusTitle,
    addresses: undefined,
  }
}
