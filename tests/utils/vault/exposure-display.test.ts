import { describe, expect, it } from 'vitest'
import {
  buildAllocatedVaultExposureDisplayItems,
  buildFallbackVaultExposureDisplay,
  combineVaultExposureDisplays,
  mergeVaultExposureDisplayItems,
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
  it('weights utilized exposure by live open-interest split and keeps only the remainder idle', () => {
    const items = buildAllocatedVaultExposureDisplayItems({
      collateralGroups: [
        group('wstETH', 80),
        group('cbBTC', 20),
      ],
      totalExposureUsd: 100,
      idleAsset: { address: '0xweth', symbol: 'WETH' },
      utilization: 90,
    })

    expect(items.find(item => item.asset.symbol === 'wstETH')?.valueUsd).toBeCloseTo(72)
    expect(items.find(item => item.asset.symbol === 'cbBTC')?.valueUsd).toBeCloseTo(18)
    expect(items.find(item => item.label === 'WETH Idle')?.valueUsd).toBeCloseTo(10)
  })

  it('does not infer collateral exposure when the live split is missing', () => {
    const items = buildAllocatedVaultExposureDisplayItems({
      collateralGroups: [group('wstETH', 0)],
      totalExposureUsd: 100,
      idleAsset: { address: '0xweth', symbol: 'WETH' },
      utilization: 99,
    })

    expect(items.find(item => item.asset.symbol === 'wstETH')).toBeUndefined()
    expect(items.find(item => item.label === 'WETH Idle')).toBeUndefined()
    expect(items).toHaveLength(0)
  })

  it('keeps idle exposure when utilization is zero', () => {
    const items = buildAllocatedVaultExposureDisplayItems({
      collateralGroups: [group('wstETH', 0)],
      totalExposureUsd: 100,
      idleAsset: { address: '0xweth', symbol: 'WETH' },
      utilization: 0,
    })

    expect(items.find(item => item.label === 'WETH Idle')?.valueUsd).toBeCloseTo(100)
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
        label: 'USDC Idle',
        valueUsd: 10,
      },
    ])

    expect(items.map(item => item.label ?? item.asset.symbol)).toEqual(['USDC', 'USDC Idle'])
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
  const idleAsset = { address: '0xweth', symbol: 'WETH' }

  it('resolves an exact ready split for a single-collateral vault', () => {
    const { valueState, items } = buildFallbackVaultExposureDisplay({
      collateralGroups: [group('wstETH', 0)],
      totalExposureUsd: 100,
      totalSupplyState: 'ready',
      idleAsset,
      utilization: 90,
    })

    expect(valueState).toBe('ready')
    expect(items.find(item => item.asset.symbol === 'wstETH')?.valueUsd).toBeCloseTo(90)
    expect(items.find(item => item.label === 'WETH Idle')?.valueUsd).toBeCloseTo(10)
  })

  it('resolves an exact idle-only split when nothing is utilized', () => {
    const { valueState, items } = buildFallbackVaultExposureDisplay({
      collateralGroups: [group('wstETH', 0), group('cbBTC', 0)],
      totalExposureUsd: 100,
      totalSupplyState: 'ready',
      idleAsset,
      utilization: 0,
    })

    expect(valueState).toBe('ready')
    expect(items).toHaveLength(1)
    expect(items[0].label).toBe('WETH Idle')
    expect(items[0].valueUsd).toBeCloseTo(100)
  })

  it('lists backing assets qualitatively when a multi-collateral split is unknown', () => {
    const { valueState, items } = buildFallbackVaultExposureDisplay({
      collateralGroups: [group('wstETH', 0), group('cbBTC', 0)],
      totalExposureUsd: 100,
      totalSupplyState: 'ready',
      idleAsset,
      utilization: 90,
    })

    expect(valueState).toBe('unavailable')
    expect(items.map(item => item.label ?? item.asset.symbol).sort()).toEqual(['WETH Idle', 'cbBTC', 'wstETH'])
    expect(items.every(item => item.valueUsd === 0)).toBe(true)
  })

  it('omits the idle row from the qualitative list at full utilization', () => {
    const { valueState, items } = buildFallbackVaultExposureDisplay({
      collateralGroups: [group('wstETH', 0), group('cbBTC', 0)],
      totalExposureUsd: 100,
      totalSupplyState: 'ready',
      idleAsset,
      utilization: 100,
    })

    expect(valueState).toBe('unavailable')
    expect(items.map(item => item.asset.symbol).sort()).toEqual(['cbBTC', 'wstETH'])
  })

  it('stays qualitative when total supply is unavailable', () => {
    const { valueState, items } = buildFallbackVaultExposureDisplay({
      collateralGroups: [group('wstETH', 0)],
      totalExposureUsd: 0,
      totalSupplyState: 'unavailable',
      idleAsset,
      utilization: 50,
    })

    expect(valueState).toBe('unavailable')
    expect(items.map(item => item.label ?? item.asset.symbol).sort()).toEqual(['WETH Idle', 'wstETH'])
  })

  it('reports loading while total supply is loading', () => {
    const { valueState, items } = buildFallbackVaultExposureDisplay({
      collateralGroups: [group('wstETH', 0)],
      totalExposureUsd: 0,
      totalSupplyState: 'loading',
      idleAsset,
      utilization: 50,
    })

    expect(valueState).toBe('loading')
    expect(items).toHaveLength(0)
  })

  it('keeps an empty ready state for vaults with no supply', () => {
    const { valueState, items } = buildFallbackVaultExposureDisplay({
      collateralGroups: [group('wstETH', 0)],
      totalExposureUsd: 0,
      totalSupplyState: 'ready',
      idleAsset,
      utilization: 50,
    })

    expect(valueState).toBe('ready')
    expect(items).toHaveLength(0)
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
