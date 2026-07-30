import type { ActivityEvent } from '@eulerxyz/euler-v2-sdk'
import type { ActivityLiquidationDisplayDetails } from '~/utils/activity-display'

const QUEUE_EVENT_TYPES: readonly ActivityEvent['type'][] = [
  'set_supply_queue',
  'set_withdraw_queue',
]

export const getActivityAddressCollectionSummary = (
  eventType: ActivityEvent['type'],
  count: number,
): string | null => {
  if (count <= 1) return null
  return QUEUE_EVENT_TYPES.includes(eventType)
    ? `${count} strategies`
    : `${count} addresses`
}

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
