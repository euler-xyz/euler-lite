import { describe, expect, it } from 'vitest'
import { normalizeLiquidationsResponse, type ActivityAssetAmount } from '@eulerxyz/euler-v2-sdk'
import { getActivityLiquidationDisplayDetails } from '~/utils/activity-display'
import { liquidationPage, oracleUsdLiquidation } from '~/tests/fixtures/liquidation-oracle-usd'
import {
  getActivityAddressCollectionSummary,
  getActivityAssetDisplayValues,
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

describe('ActivityEventRow liquidation amounts', () => {
  const event = { type: 'liquidation', category: 'liquidations' } as const
  const shares: ActivityAssetAmount = {
    kind: 'collateral',
    amountRaw: oracleUsdLiquidation.yieldBalance,
    decimals: 18,
    symbol: 'eCOLL',
  }
  const debt: ActivityAssetAmount = {
    kind: 'assets', amountRaw: oracleUsdLiquidation.repayAssets, decimals: 6, symbol: 'USDC',
  }

  it.each(['historical-price-snapshots', 'historical-protocol-oracle'])(
    'prefers available liquidation USD from %s while preserving native/share quantities',
    (source) => {
      const [record] = normalizeLiquidationsResponse(liquidationPage([{
        ...oracleUsdLiquidation,
        valuation: { status: 'available', source },
      }])).data
      const display = getActivityLiquidationDisplayDetails(record)
      expect(display.collateralAmount).toBeUndefined()
      expect(getActivityAssetDisplayValues({ ...shares, amountUsd: '1' }, event, display)).toEqual({
        label: 'Collateral shares seized', amount: '8.15 eCOLL', usd: '$8.15',
      })
      expect(getActivityAssetDisplayValues({ ...debt, amountUsd: '1' }, event, display)).toEqual({
        label: 'Debt repaid', amount: '8.04 USDC', usd: '$8.04',
      })
      expect(getActivityLiquidationBonusEntry(display)).toMatchObject({
        value: '+$0.12', valueClass: 'text-accent-600',
        valueTitle: 'Collateral seized minus debt repaid, valued in event-time USD',
      })
    },
  )

  it('shows USD even when the share decimals and native conversion are unavailable', () => {
    const [record] = normalizeLiquidationsResponse(liquidationPage([oracleUsdLiquidation])).data
    expect(getActivityAssetDisplayValues(
      { ...shares, decimals: undefined }, event, getActivityLiquidationDisplayDetails(record),
    )).toEqual({ label: 'Collateral shares seized', amount: 'Amount unavailable', usd: '$8.15' })
  })

  it('keeps converted collateral units when USD is unavailable', () => {
    const [record] = normalizeLiquidationsResponse(liquidationPage([{
      ...oracleUsdLiquidation,
      collateralAsset: oracleUsdLiquidation.debtAsset,
      collateralAssetDecimals: 6,
      collateralAssets: '8152917',
      collateralAssetsUsd: null,
      bonusUsd: null,
      valuation: { status: 'partial', source: 'historical-price-snapshots' },
    }])).data
    const display = getActivityLiquidationDisplayDetails(record, address => ({ address, symbol: 'USDC', decimals: 6 }))
    expect(getActivityAssetDisplayValues(shares, event, display)).toEqual({
      label: 'Collateral seized', amount: '8.15 USDC', usd: null,
    })
    expect(display.bonus).toBe('+0.12 USD')
  })

  it('falls back to event USD and native/share quantities without liquidation enrichment', () => {
    expect(getActivityAssetDisplayValues({ ...shares, amountUsd: '2' }, event, null)).toEqual({
      label: 'Collateral shares seized', amount: '8.15 eCOLL', usd: '$2.00',
    })
    expect(getActivityAssetDisplayValues(debt, event, null)).toEqual({
      label: 'Debt repaid', amount: '8.04 USDC', usd: null,
    })
    expect(getActivityAssetDisplayValues(debt, event, { repayUsd: '$0.00' }).usd).toBe('$0.00')
  })

  it('retains token-denominated oracle bonus fallback without USD', () => {
    const [record] = normalizeLiquidationsResponse(liquidationPage([{
      ...oracleUsdLiquidation,
      repayAssetsUsd: null,
      collateralAssetsUsd: null,
      bonusUsd: null,
      valuation: { status: 'unavailable', source: 'historical-price-snapshots' },
      unitOfAccountValuation: {
        ...oracleUsdLiquidation.unitOfAccountValuation,
        unitOfAccount: oracleUsdLiquidation.debtAsset,
        unitOfAccountDecimals: 6,
        repayValue: '8035323',
        collateralValue: '8152917',
        bonusValue: '117594',
      },
    }])).data
    const display = getActivityLiquidationDisplayDetails(record, address => ({ address, symbol: 'USDC', decimals: 6 }))
    expect(getActivityLiquidationBonusEntry(display)).toMatchObject({
      value: '+0.12 USDC', valueClass: 'text-accent-600',
      valueTitle: 'Collateral seized minus debt repaid, quoted by the protocol oracle at the liquidation',
    })
    expect(getActivityAssetDisplayValues(shares, event, display).usd).toBeNull()
  })
})
