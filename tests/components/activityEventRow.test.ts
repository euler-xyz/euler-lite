import { describe, expect, it } from 'vitest'
import {
  getActivityAddressCollectionSummary,
  getActivityLiquidationBonusEntry,
} from '~/components/entities/activity/activityEventRowDetails'

describe('ActivityEventRow liquidation bonus details', () => {
  it('summarizes multi-strategy queues in collapsed rows', () => {
    expect(getActivityAddressCollectionSummary('set_withdraw_queue', 14)).toBe('14 strategies')
    expect(getActivityAddressCollectionSummary('set_supply_queue', 4)).toBe('4 strategies')
    expect(getActivityAddressCollectionSummary('set_withdraw_queue', 1)).toBeNull()
  })

  it('renders protocol-oracle fallback text with the existing signed tone', () => {
    expect(getActivityLiquidationBonusEntry({
      bonus: '+1.14 USD',
      bonusTone: 'positive',
      bonusTitle: 'Collateral seized minus debt repaid, quoted by the protocol oracle at the liquidation',
    })).toMatchObject({
      label: 'Liquidator bonus',
      value: '+1.14 USD',
      valueClass: 'text-accent-600',
      valueTitle: 'Collateral seized minus debt repaid, quoted by the protocol oracle at the liquidation',
    })

    expect(getActivityLiquidationBonusEntry({
      bonus: '−0.25 USDC',
      bonusTone: 'negative',
    })).toMatchObject({
      value: '−0.25 USDC',
      valueClass: 'text-error-500',
    })
  })

  it('omits the row when neither USD nor a usable fallback is available', () => {
    expect(getActivityLiquidationBonusEntry(null)).toBeNull()
    expect(getActivityLiquidationBonusEntry({})).toBeNull()
  })
})
