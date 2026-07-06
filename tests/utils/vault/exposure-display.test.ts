import { describe, expect, it } from 'vitest'
import {
  buildAllocatedVaultExposureDisplayItems,
  buildFallbackVaultExposureDisplay,
  combineVaultExposureDisplays,
  mergeVaultExposureDisplayItems,
  resolveVaultExposureDisplay,
  sortVaultExposureDisplayItems,
} from '~/utils/vault/exposure-display'
import type { CollateralExposureGroup } from '~/utils/vault/collateral-exposure'

const group = (
  symbol: string,
  openInterestUsd: number,
  maxBorrowLTV = 0.86,
): CollateralExposureGroup => ({
  asset: {
    address: `0x${symbol.toLowerCase().padEnd(40, '0')}`,
    symbol,
  },
  items: [],
  vaultCount: 1,
  maxBorrowLTV,
  maxCurrentLiquidationLTV: maxBorrowLTV,
  openInterestUsd,
})

describe('buildAllocatedVaultExposureDisplayItems', () => {
  it('weights utilized exposure by the live open-interest split and excludes idle', () => {
    const items = buildAllocatedVaultExposureDisplayItems({
      collateralGroups: [
        group('wstETH', 80),
        group('cbBTC', 20),
      ],
      totalExposureUsd: 100,
      utilization: 90,
    })

    expect(items.find(item => item.asset.symbol === 'wstETH')?.valueUsd).toBeCloseTo(72)
    expect(items.find(item => item.asset.symbol === 'cbBTC')?.valueUsd).toBeCloseTo(18)
    // Idle (un-utilized) supply is never shown as exposure.
    expect(items.some(item => item.label?.includes('Idle'))).toBe(false)
  })

  it('does not infer collateral exposure when the live split is missing', () => {
    const items = buildAllocatedVaultExposureDisplayItems({
      collateralGroups: [group('wstETH', 0)],
      totalExposureUsd: 100,
      utilization: 99,
    })

    expect(items).toHaveLength(0)
  })

  it('renders accepted collaterals at $0 when nothing is utilized', () => {
    const items = buildAllocatedVaultExposureDisplayItems({
      collateralGroups: [group('wstETH', 0)],
      totalExposureUsd: 100,
      utilization: 0,
    })

    expect(items.find(item => item.asset.symbol === 'wstETH')?.valueUsd).toBe(0)
    expect(items.some(item => item.label?.includes('Idle'))).toBe(false)
  })

  it('keeps accepted collaterals without open interest as zero-value rows', () => {
    const items = buildAllocatedVaultExposureDisplayItems({
      collateralGroups: [
        group('wstETH', 80),
        group('cbBTC', 0),
      ],
      totalExposureUsd: 100,
      utilization: 90,
    })

    expect(items.find(item => item.asset.symbol === 'wstETH')?.valueUsd).toBeCloseTo(90)
    expect(items.find(item => item.asset.symbol === 'cbBTC')?.valueUsd).toBe(0)
    expect(items.some(item => item.label?.includes('Idle'))).toBe(false)
  })
})

describe('mergeVaultExposureDisplayItems', () => {
  it('merges duplicate assets with the same display label', () => {
    const items = mergeVaultExposureDisplayItems([
      {
        asset: { address: '0x0000000000000000000000000000000000000001', symbol: 'USDC' },
        label: 'USDC',
        valueUsd: 10,
        sources: [{ label: 'Market A' }],
      },
      {
        asset: { address: '0x0000000000000000000000000000000000000001', symbol: 'USDC' },
        label: 'USDC',
        valueUsd: 15,
        sources: [{ label: 'Market A' }, { label: 'Market B' }],
      },
    ])

    expect(items).toHaveLength(1)
    expect(items[0].valueUsd).toBe(25)
    expect(items[0].sources?.map(source => source.label)).toEqual(['Market A', 'Market B'])
  })

  it('keeps the same asset separate when labels differ', () => {
    const items = mergeVaultExposureDisplayItems([
      {
        asset: { address: '0x0000000000000000000000000000000000000001', symbol: 'USDC' },
        valueUsd: 90,
      },
      {
        asset: { address: '0x0000000000000000000000000000000000000001', symbol: 'USDC' },
        label: 'USDC (alt)',
        valueUsd: 10,
      },
    ])

    expect(items.map(item => item.label ?? item.asset.symbol)).toEqual(['USDC', 'USDC (alt)'])
  })
})

describe('sortVaultExposureDisplayItems', () => {
  it('sorts by descending USD value and then label', () => {
    const items = sortVaultExposureDisplayItems([
      {
        asset: { address: '0x0000000000000000000000000000000000000002', symbol: 'WETH' },
        valueUsd: 10,
      },
      {
        asset: { address: '0x0000000000000000000000000000000000000003', symbol: 'cbBTC' },
        valueUsd: 20,
      },
      {
        asset: { address: '0x0000000000000000000000000000000000000001', symbol: 'USDC' },
        valueUsd: 20,
      },
    ])

    expect(items.map(item => item.asset.symbol)).toEqual(['cbBTC', 'USDC', 'WETH'])
  })
})

describe('buildFallbackVaultExposureDisplay', () => {
  it('resolves an exact ready split for a single-collateral vault', () => {
    const { valueState, items } = buildFallbackVaultExposureDisplay({
      collateralGroups: [group('wstETH', 0)],
      totalExposureUsd: 100,
      totalSupplyState: 'ready',
      utilization: 90,
      acceptedCollateralCount: 1,
    })

    expect(valueState).toBe('ready')
    expect(items.find(item => item.asset.symbol === 'wstETH')?.valueUsd).toBeCloseTo(90)
    expect(items.some(item => item.label?.includes('Idle'))).toBe(false)
  })

  it('resolves an exact split with zero-value collateral rows when nothing is utilized', () => {
    const { valueState, items } = buildFallbackVaultExposureDisplay({
      collateralGroups: [group('wstETH', 0), group('cbBTC', 0)],
      totalExposureUsd: 100,
      totalSupplyState: 'ready',
      utilization: 0,
      acceptedCollateralCount: 2,
    })

    expect(valueState).toBe('ready')
    expect(items.find(item => item.asset.symbol === 'wstETH')?.valueUsd).toBe(0)
    expect(items.find(item => item.asset.symbol === 'cbBTC')?.valueUsd).toBe(0)
    expect(items.some(item => item.label?.includes('Idle'))).toBe(false)
  })

  it('lists backing assets qualitatively when a multi-collateral split is unknown', () => {
    const { valueState, items } = buildFallbackVaultExposureDisplay({
      collateralGroups: [group('wstETH', 0), group('cbBTC', 0)],
      totalExposureUsd: 100,
      totalSupplyState: 'ready',
      utilization: 90,
      acceptedCollateralCount: 2,
    })

    expect(valueState).toBe('unavailable')
    expect(items.map(item => item.asset.symbol).sort()).toEqual(['cbBTC', 'wstETH'])
    expect(items.every(item => item.valueUsd === 0)).toBe(true)
  })

  it('stays qualitative when a single live group hides a multi-collateral vault', () => {
    // A vault that accepts several collaterals but whose live group set collapsed
    // to one (registry miss, or liquidation LTV ramped to 0 with residual debt)
    // must not attribute 100% of utilized exposure to the survivor.
    const { valueState, items } = buildFallbackVaultExposureDisplay({
      collateralGroups: [group('wstETH', 0)],
      totalExposureUsd: 100,
      totalSupplyState: 'ready',
      utilization: 90,
      acceptedCollateralCount: 2,
    })

    expect(valueState).toBe('unavailable')
    expect(items.map(item => item.asset.symbol)).toEqual(['wstETH'])
    expect(items.every(item => item.valueUsd === 0)).toBe(true)
  })

  it('lists just the collaterals qualitatively at full utilization', () => {
    const { valueState, items } = buildFallbackVaultExposureDisplay({
      collateralGroups: [group('wstETH', 0), group('cbBTC', 0)],
      totalExposureUsd: 100,
      totalSupplyState: 'ready',
      utilization: 100,
      acceptedCollateralCount: 2,
    })

    expect(valueState).toBe('unavailable')
    expect(items.map(item => item.asset.symbol).sort()).toEqual(['cbBTC', 'wstETH'])
  })

  it('stays qualitative when total supply is unavailable', () => {
    const { valueState, items } = buildFallbackVaultExposureDisplay({
      collateralGroups: [group('wstETH', 0)],
      totalExposureUsd: 0,
      totalSupplyState: 'unavailable',
      utilization: 50,
      acceptedCollateralCount: 1,
    })

    expect(valueState).toBe('unavailable')
    expect(items.map(item => item.asset.symbol)).toEqual(['wstETH'])
  })

  it('reports loading while total supply is loading', () => {
    const { valueState, items } = buildFallbackVaultExposureDisplay({
      collateralGroups: [group('wstETH', 0)],
      totalExposureUsd: 0,
      totalSupplyState: 'loading',
      utilization: 50,
      acceptedCollateralCount: 1,
    })

    expect(valueState).toBe('loading')
    expect(items).toHaveLength(0)
  })

  it('keeps an empty ready state for vaults with no supply', () => {
    const { valueState, items } = buildFallbackVaultExposureDisplay({
      collateralGroups: [group('wstETH', 0)],
      totalExposureUsd: 0,
      totalSupplyState: 'ready',
      utilization: 50,
      acceptedCollateralCount: 1,
    })

    expect(valueState).toBe('ready')
    expect(items).toHaveLength(0)
  })
})

describe('resolveVaultExposureDisplay', () => {
  const base = {
    getCollateralGroups: () => [group('wstETH', 80), group('cbBTC', 20)],
    totalExposureUsd: 100,
    totalSupplyState: 'ready' as const,
    utilization: 90,
    acceptedCollateralCount: 2,
  }

  it('reports loading without building groups while open interest is loading', () => {
    let built = false
    const display = resolveVaultExposureDisplay({
      ...base,
      openInterestEnabled: true,
      openInterestLoaded: false,
      hasOpenInterestError: false,
      getCollateralGroups: () => {
        built = true
        return []
      },
    })

    expect(display.valueState).toBe('loading')
    expect(built).toBe(false)
  })

  it('uses the live allocated split when open interest is available', () => {
    const { valueState, items } = resolveVaultExposureDisplay({
      ...base,
      openInterestEnabled: true,
      openInterestLoaded: true,
      hasOpenInterestError: false,
    })

    expect(valueState).toBe('ready')
    expect(items.find(item => item.asset.symbol === 'wstETH')?.valueUsd).toBeCloseTo(72)
    expect(items.find(item => item.asset.symbol === 'cbBTC')?.valueUsd).toBeCloseTo(18)
  })

  it('degrades to the qualitative list when a utilized vault has no open-interest rows', () => {
    const { valueState, items } = resolveVaultExposureDisplay({
      ...base,
      getCollateralGroups: () => [group('wstETH', 0), group('cbBTC', 0)],
      openInterestEnabled: true,
      openInterestLoaded: true,
      hasOpenInterestError: false,
    })

    expect(valueState).toBe('unavailable')
    expect(items.map(item => item.asset.symbol).sort()).toEqual(['cbBTC', 'wstETH'])
  })

  it('falls back to an exact split on a gated chain with a single accepted collateral', () => {
    const { valueState, items } = resolveVaultExposureDisplay({
      ...base,
      getCollateralGroups: () => [group('wstETH', 0)],
      acceptedCollateralCount: 1,
      openInterestEnabled: false,
      openInterestLoaded: false,
      hasOpenInterestError: false,
    })

    expect(valueState).toBe('ready')
    expect(items.find(item => item.asset.symbol === 'wstETH')?.valueUsd).toBeCloseTo(90)
  })

  it('lists assets qualitatively when open interest is live but the supply price is unavailable', () => {
    const { valueState, items } = resolveVaultExposureDisplay({
      ...base,
      openInterestEnabled: true,
      openInterestLoaded: true,
      hasOpenInterestError: false,
      totalSupplyState: 'unavailable',
      totalExposureUsd: 0,
    })

    expect(valueState).toBe('unavailable')
    expect(items.map(item => item.asset.symbol).sort()).toEqual(['cbBTC', 'wstETH'])
  })
})

describe('combineVaultExposureDisplays', () => {
  const item = (symbol: string, valueUsd: number) => ({
    asset: { address: `0x${symbol.toLowerCase().padEnd(40, '0')}`, symbol },
    valueUsd,
  })

  it('returns an empty ready display with no inputs', () => {
    expect(combineVaultExposureDisplays([])).toEqual({ valueState: 'ready', items: [] })
  })

  it('merges ready displays into a ready total', () => {
    const { valueState, items } = combineVaultExposureDisplays([
      { valueState: 'ready', items: [item('wstETH', 60)] },
      { valueState: 'ready', items: [item('wstETH', 20), item('cbBTC', 20)] },
    ])

    expect(valueState).toBe('ready')
    expect(items.find(entry => entry.asset.symbol === 'wstETH')?.valueUsd).toBe(80)
    expect(items.find(entry => entry.asset.symbol === 'cbBTC')?.valueUsd).toBe(20)
  })

  it('reports loading while any input is loading', () => {
    expect(combineVaultExposureDisplays([
      { valueState: 'ready', items: [item('wstETH', 60)] },
      { valueState: 'loading', items: [] },
    ])).toEqual({ valueState: 'loading', items: [] })
  })

  it('zeroes values when any input lacks a known split', () => {
    const { valueState, items } = combineVaultExposureDisplays([
      { valueState: 'ready', items: [item('wstETH', 60)] },
      { valueState: 'unavailable', items: [item('cbBTC', 0)] },
    ])

    expect(valueState).toBe('unavailable')
    expect(items.map(entry => entry.asset.symbol).sort()).toEqual(['cbBTC', 'wstETH'])
    expect(items.every(entry => entry.valueUsd === 0)).toBe(true)
  })
})
