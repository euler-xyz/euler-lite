import type { ActivityAssetAmount, ActivityEvent } from '@eulerxyz/euler-v2-sdk'
import {
  formatActivityAssetAmount,
  formatActivityAssetUsd,
  getActivityAssetLabel,
  type ActivityLiquidationDisplayDetails,
} from '~/utils/activity-display'

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

/** Liquidation USD and native conversion are independent enrichments. */
export const getActivityAssetDisplayValues = (
  asset: ActivityAssetAmount,
  event: Pick<ActivityEvent, 'type' | 'category'>,
  liquidation: ActivityLiquidationDisplayDetails | null,
) => {
  const converted = asset.kind === 'collateral' ? liquidation?.collateralAmount : undefined
  const usd = asset.kind === 'assets'
    ? liquidation?.repayUsd
    : asset.kind === 'collateral'
      ? liquidation?.collateralUsd
      : undefined
  return {
    amount: converted ?? formatActivityAssetAmount(asset, event.type),
    label: converted
      ? 'Collateral seized'
      : getActivityAssetLabel(asset.kind, event.category, event.type),
    usd: usd ?? formatActivityAssetUsd(asset),
  }
}
