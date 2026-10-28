import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import {
  buildAllocatedVaultExposureDisplayItems,
  buildFallbackVaultExposureDisplay,
  combineVaultExposureDisplays,
  getExposureLead,
  mergeVaultExposureDisplayItems,
  getVaultBackingLead,
  getVaultHeaderAssets,
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

  it('omits collaterals with no current exposure when nothing is utilized', () => {
    const items = buildAllocatedVaultExposureDisplayItems({
      collateralGroups: [group('wstETH', 0)],
      totalExposureUsd: 100,
      utilization: 0,
    })

    expect(items).toHaveLength(0)
  })

  it('omits accepted collaterals with no current open interest from the known split', () => {
    const items = buildAllocatedVaultExposureDisplayItems({
      collateralGroups: [
        group('wstETH', 80),
        group('cbBTC', 0),
      ],
      totalExposureUsd: 100,
      utilization: 90,
    })

    expect(items.find(item => item.asset.symbol === 'wstETH')?.valueUsd).toBeCloseTo(90)
    expect(items.find(item => item.asset.symbol === 'cbBTC')).toBeUndefined()
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

  it('collapses to an empty ready split when nothing is utilized', () => {
    const { valueState, items } = buildFallbackVaultExposureDisplay({
      collateralGroups: [group('wstETH', 0), group('cbBTC', 0)],
      totalExposureUsd: 100,
      totalSupplyState: 'ready',
      utilization: 0,
      acceptedCollateralCount: 2,
    })

    expect(valueState).toBe('ready')
    expect(items).toHaveLength(0)
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

describe('getExposureLead', () => {
  const asset = (symbol: string) => ({ address: `0x${symbol.padStart(40, '0').toLowerCase().replace(/[^0-9a-f]/g, '0')}`, symbol })
  const item = (symbol: string, valueUsd: number) => ({ asset: asset(symbol), valueUsd })

  it('leads with the collateral backing borrows, largest first, the rest counted', () => {
    const lead = getExposureLead({ valueState: 'ready', items: [item('WBTC', 10), item('wstETH', 50), item('cbBTC', 5), item('LINK', 1)] })
    expect(lead?.assets.map(entry => entry.symbol)).toEqual(['wstETH', 'WBTC', 'cbBTC'])
    expect(lead?.label).toBe('Backed by wstETH, WBTC, cbBTC +1')
  })

  it('names accepted collateral when the split is unknown', () => {
    expect(getExposureLead({ valueState: 'unavailable', items: [item('WBTC', 0)] })?.label).toBe('Accepts WBTC')
  })

  it('has no lead when nothing backs the strategy or it is still loading', () => {
    expect(getExposureLead({ valueState: 'ready', items: [] })).toBeNull()
    expect(getExposureLead({ valueState: 'loading', items: [] })).toBeNull()
  })
})

describe('getVaultBackingLead', () => {
  const live = { openInterestEnabled: true, openInterestLoaded: true, hasOpenInterestError: false }

  it('names what backs a vault\'s borrows even when a depositor holds none of it', () => {
    expect(getVaultBackingLead({
      ...live,
      getCollateralGroups: () => [group('WBTC', 10), group('wstETH', 50), group('USDT', 0)],
      utilization: 23,
      acceptedCollateralCount: 3,
    })?.label).toBe('Backed by wstETH, WBTC')
  })

  it('names accepted collateral for a vault without borrows', () => {
    expect(getVaultBackingLead({
      ...live,
      getCollateralGroups: () => [group('WBTC', 0), group('wstETH', 0)],
      utilization: 0,
      acceptedCollateralCount: 2,
    })?.label).toBe('Accepts WBTC, wstETH')
    expect(getVaultBackingLead({
      openInterestEnabled: false,
      openInterestLoaded: false,
      hasOpenInterestError: false,
      getCollateralGroups: () => [group('WBTC', 0)],
      utilization: 0,
      acceptedCollateralCount: 1,
    })?.label).toBe('Accepts WBTC')
  })

  it('leaves out collateral that cannot back a new borrow for a vault without borrows', () => {
    expect(getVaultBackingLead({
      ...live,
      getCollateralGroups: () => [group('WBTC', 0, 0), group('wstETH', 0), group('cbBTC', 0), group('tBTC', 0)],
      utilization: 0,
      acceptedCollateralCount: 4,
    })?.label).toBe('Accepts cbBTC, tBTC, wstETH')
    expect(getVaultBackingLead({
      ...live,
      getCollateralGroups: () => [group('WBTC', 0, 0)],
      utilization: 0,
      acceptedCollateralCount: 1,
    })).toBeNull()
  })

  it('has no lead for a vault without borrows or live collateral', () => {
    expect(getVaultBackingLead({
      ...live,
      getCollateralGroups: () => [],
      utilization: 0,
      acceptedCollateralCount: 1,
    })).toBeNull()
  })

  it('has no lead while open interest loads', () => {
    expect(getVaultBackingLead({
      ...live,
      openInterestLoaded: false,
      getCollateralGroups: () => [group('WBTC', 0)],
      utilization: 0,
      acceptedCollateralCount: 1,
    })).toBeNull()
    expect(getVaultBackingLead({
      ...live,
      openInterestLoaded: false,
      getCollateralGroups: () => [group('WBTC', 10)],
      utilization: 40,
      acceptedCollateralCount: 1,
    })).toBeNull()
  })

  it('names accepted collateral when the borrow split is unknown', () => {
    expect(getVaultBackingLead({
      ...live,
      hasOpenInterestError: true,
      getCollateralGroups: () => [group('WBTC', 0), group('wstETH', 0)],
      utilization: 40,
      acceptedCollateralCount: 2,
    })?.label).toBe('Accepts WBTC, wstETH')
    expect(getVaultBackingLead({
      ...live,
      getCollateralGroups: () => [group('WBTC', 0), group('wstETH', 0)],
      utilization: 40,
      acceptedCollateralCount: 2,
    })?.label).toBe('Accepts WBTC, wstETH')
  })
})

describe('getVaultHeaderAssets', () => {
  const usdc = { address: '0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48' as const, decimals: 6, name: 'USD Coin', symbol: 'USDC' }
  const live = { enabled: true, loaded: true, hasError: false }

  it('names a strategy\'s own backing, from its utilization and borrow split alone', () => {
    const header = getVaultHeaderAssets(
      { utilization: 23, collaterals: [{}, {}], asset: usdc },
      live,
      () => [
        { ...group('WBTC', 10), asset: { address: '0x2260fac5e5542a773aa44fbcfedf7c193bc2c599', symbol: 'WBTC' } },
        { ...group('wstETH', 50), asset: { address: '0x7f39c581f595b53c5cb19bd0b3f8da6c935e2ca0', symbol: 'wstETH' } },
      ],
    )
    expect(header.label).toBe('Backed by wstETH, WBTC')
    expect(header.assets.map(asset => asset.symbol)).toEqual(['wstETH', 'WBTC'])
  })

  it('falls back to the vault\'s asset when nothing backs it', () => {
    expect(getVaultHeaderAssets({ utilization: 0, collaterals: [], asset: usdc }, live, () => [])).toEqual({ assets: [usdc] })
  })

  describe('a strategy without borrows', () => {
    const usdt = { address: '0x55d398326f99059fF775485246999027B3197955' as const, decimals: 18, name: 'Tether USD', symbol: 'USDT' }
    const mub = { address: '0x1111111111111111111111111111111111111111', decimals: 18, name: 'MUB', symbol: 'MUB' }
    const nvdab = { address: '0x2222222222222222222222222222222222222222', decimals: 18, name: 'NVDAB', symbol: 'NVDAB' }
    const strategyGroup = (asset: typeof mub, openInterestUsd: number) => ({ ...group(asset.symbol, openInterestUsd), asset })

    it('names the collateral it accepts', () => {
      const header = getVaultHeaderAssets({ utilization: 0, collaterals: [{}], asset: usdt }, live, () => [strategyGroup(mub, 0)])
      expect(header.label).toBe('Accepts MUB')
      expect(header.assets).toEqual([{ ...mub, address: getAddress(mub.address) }])
    })

    it('keeps "Backed by" once anything is borrowed', () => {
      const header = getVaultHeaderAssets({ utilization: 0.01, collaterals: [{}], asset: usdt }, live, () => [strategyGroup(nvdab, 12)])
      expect(header.label).toBe('Backed by NVDAB')
    })

    it('falls back to its asset when no accepted collateral is live', () => {
      expect(getVaultHeaderAssets({ utilization: 0, collaterals: [{}], asset: usdt }, live, () => [])).toEqual({ assets: [usdt] })
    })

    it('falls back to its asset while open interest loads', () => {
      expect(getVaultHeaderAssets({ utilization: 0, collaterals: [{}], asset: usdt }, { ...live, loaded: false }, () => [strategyGroup(mub, 0)]))
        .toEqual({ assets: [usdt] })
    })
  })
})
