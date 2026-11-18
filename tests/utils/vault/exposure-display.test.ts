import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import {
  buildAllocatedVaultExposureDisplayItems,
  buildFallbackVaultExposureDisplay,
  combineVaultExposureDisplays,
  getExposureLead,
  getHeldSupplyShare,
  mergeVaultExposureDisplayItems,
  getVaultBackingLead,
  getVaultHeaderAssets,
  resolveVaultExposureDisplay,
  sortVaultExposureDisplayItems,
  UNCOVERED_EXPOSURE_LABEL,
} from '~/utils/vault/exposure-display'
import type { CollateralExposureGroup } from '~/utils/vault/collateral-exposure'
import {
  BOLD,
  EUSDC_42_BAD_DEBT_USD,
  EUSDC_42_OPEN_INTEREST_USD,
  EBOLD_1,
  ESBOLD_1,
  EUSDC_42_TOTAL_SUPPLY_USD,
  EUSDC_42_UTILIZATION,
  PT_SBOLD_1765325646,
  PT_SBOLD_27NOV2025,
  SBOLD,
  USDC,
} from '~/tests/fixtures/liquity-hub'

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

describe('exposure with uncovered bad debt (K3 Liquity Hub eUSDC-42)', () => {
  const backing = (asset: { address: string, symbol: string }, openInterestUsd: number): CollateralExposureGroup => ({
    ...group(asset.symbol, openInterestUsd),
    asset: { address: asset.address.toLowerCase(), symbol: asset.symbol },
  })
  const eusdc42Groups = () => [
    backing(BOLD, EUSDC_42_OPEN_INTEREST_USD[EBOLD_1]),
    backing(SBOLD, EUSDC_42_OPEN_INTEREST_USD[ESBOLD_1]),
    backing(PT_SBOLD_1765325646, 0),
    backing(PT_SBOLD_27NOV2025, 0),
  ]
  const coveredUsd = EUSDC_42_OPEN_INTEREST_USD[EBOLD_1] + EUSDC_42_OPEN_INTEREST_USD[ESBOLD_1]
  const liveUtilizedUsd = EUSDC_42_TOTAL_SUPPLY_USD * EUSDC_42_UTILIZATION / 100
  const live = {
    openInterestEnabled: true,
    openInterestLoaded: true,
    hasOpenInterestError: false,
    totalSupplyState: 'ready' as const,
    acceptedCollateralCount: 4,
  }
  const eusdc42 = {
    ...live,
    getCollateralGroups: eusdc42Groups,
    totalExposureUsd: EUSDC_42_TOTAL_SUPPLY_USD,
    utilization: EUSDC_42_UTILIZATION,
    vaultShare: 1,
  }
  const valueOf = (items: ReturnType<typeof buildAllocatedVaultExposureDisplayItems>, label: string) =>
    items.find(item => (item.label ?? item.asset.symbol) === label)?.valueUsd ?? 0
  const sum = (items: ReturnType<typeof buildAllocatedVaultExposureDisplayItems>) => items.reduce((total, item) => total + item.valueUsd, 0)

  it('splits the live utilized amount by the V3 ratio of bad debt to covered debt', () => {
    const { valueState, items } = resolveVaultExposureDisplay({ ...eusdc42, badDebtUsd: EUSDC_42_BAD_DEBT_USD })

    expect(valueState).toBe('ready')
    expect(valueOf(items, UNCOVERED_EXPOSURE_LABEL)).toBeCloseTo(liveUtilizedUsd * EUSDC_42_BAD_DEBT_USD / (EUSDC_42_BAD_DEBT_USD + coveredUsd), 6)
    expect(valueOf(items, UNCOVERED_EXPOSURE_LABEL)).toBeCloseTo(17_556, 0)
    expect(valueOf(items, 'BOLD')).toBeCloseTo(1.29, 2)
    expect(valueOf(items, 'sBOLD')).toBeLessThan(1e-9)
    expect(sum(items)).toBeCloseTo(liveUtilizedUsd, 6)
    expect(items.find(item => item.kind === 'uncovered')?.label).toBe(UNCOVERED_EXPOSURE_LABEL)
    expect(sortVaultExposureDisplayItems(items)[0].kind).toBe('uncovered')
  })

  it('never shows more uncovered debt than is utilized', () => {
    const { items } = resolveVaultExposureDisplay({
      ...live,
      getCollateralGroups: () => [backing(BOLD, 20)],
      totalExposureUsd: 100,
      utilization: 50,
      vaultShare: 1,
      badDebtUsd: 1_000,
    })

    expect(valueOf(items, UNCOVERED_EXPOSURE_LABEL)).toBeLessThanOrEqual(50)
    expect(sum(items)).toBeCloseTo(50, 9)
  })

  it('ignores bad debt that is dust against live borrows when the open-interest rows lag', () => {
    const input = {
      ...live,
      getCollateralGroups: () => [backing(USDC, 0)],
      openInterestTotalUsd: 0,
      totalExposureUsd: 20_000_000,
      utilization: 50,
      vaultShare: 1,
    }
    const display = resolveVaultExposureDisplay({ ...input, badDebtUsd: 5 })

    expect(display.items.some(item => item.kind === 'uncovered')).toBe(false)
    expect(display).toEqual(resolveVaultExposureDisplay(input))
  })

  it('does the same for an Earn allocation of that vault', () => {
    const input = {
      ...live,
      getCollateralGroups: () => [backing(USDC, 0)],
      openInterestTotalUsd: 0,
      totalExposureUsd: 5_000_000,
      utilization: 50,
      vaultShare: 0.25,
    }

    expect(resolveVaultExposureDisplay({ ...input, badDebtUsd: 5 }).items.some(item => item.kind === 'uncovered')).toBe(false)
  })

  it('counts open interest on collaterals lite did not resolve', () => {
    const { valueState, items } = resolveVaultExposureDisplay({
      ...live,
      getCollateralGroups: () => [backing(BOLD, 1_000_000)],
      openInterestTotalUsd: 10_000_000,
      totalExposureUsd: 22_000_000,
      utilization: 50,
      vaultShare: 1,
      badDebtUsd: 1_000_000,
    })

    expect(valueState).toBe('ready')
    expect(valueOf(items, UNCOVERED_EXPOSURE_LABEL)).toBeCloseTo(1_000_000, 3)
    expect(sum(items)).toBeCloseTo(11_000_000, 3)
  })

  // Euler V3 bad debt and live borrows on Ethereum, 2026-11-18: eUSDC-75 and ewstUSR-1 have no open-interest rows.
  it('calls all borrows uncovered when V3 has no covered debt and the bad debt matches the live borrows', () => {
    const { valueState, items } = resolveVaultExposureDisplay({
      ...live,
      getCollateralGroups: () => [backing(USDC, 0)],
      openInterestTotalUsd: 0,
      totalExposureUsd: 108.5739,
      utilization: 100,
      vaultShare: 1,
      badDebtUsd: 108.5704,
    })

    expect(valueState).toBe('ready')
    expect(items).toEqual([expect.objectContaining({ kind: 'uncovered', valueUsd: 108.5739 })])
  })

  it('keeps the uncovered marker on the qualitative list when the covered rest cannot be placed', () => {
    const { valueState, items } = resolveVaultExposureDisplay({
      ...live,
      getCollateralGroups: () => [backing(USDC, 0), backing(SBOLD, 0)],
      openInterestTotalUsd: 0,
      totalExposureUsd: 83.2965,
      utilization: 100,
      vaultShare: 1,
      badDebtUsd: 81.8247,
    })

    expect(valueState).toBe('unavailable')
    expect(items.map(item => item.label ?? item.asset.symbol)).toEqual(['USDC', 'sBOLD', UNCOVERED_EXPOSURE_LABEL])
  })

  it('sizes the strategy lead on V3 bad debt plus the raw open interest', () => {
    expect(getVaultBackingLead({
      ...live,
      getCollateralGroups: () => [backing(BOLD, 1_000_000)],
      openInterestTotalUsd: 10_000_000,
      utilization: 50,
      badDebtUsd: 1_500_000,
    })?.label).toBe('Backed by BOLD')
  })

  it('shows only the uncovered item when V3 has no covered debt left', () => {
    const { valueState, items } = resolveVaultExposureDisplay({
      ...live,
      getCollateralGroups: () => [backing(SBOLD, 0)],
      totalExposureUsd: 100,
      utilization: 50,
      badDebtUsd: 40,
    })

    expect(valueState).toBe('ready')
    expect(items).toEqual([expect.objectContaining({ kind: 'uncovered', label: UNCOVERED_EXPOSURE_LABEL, valueUsd: 50 })])
  })

  it('keeps the current split when there is no bad debt', () => {
    const { vaultShare: _vaultShare, ...withoutBadDebtInputs } = eusdc42
    const before = resolveVaultExposureDisplay(withoutBadDebtInputs)

    expect(resolveVaultExposureDisplay({ ...eusdc42, badDebtUsd: 0 })).toEqual(before)
    expect(before.items.some(item => item.kind === 'uncovered')).toBe(false)
    expect(valueOf(before.items, 'BOLD')).toBeCloseTo(liveUtilizedUsd, 1)
  })

  // Euler V3 open interest and bad debt on Ethereum, 2026-11-18.
  it.each([
    ['K3 Prime eUSDC-2', 0.00272283633032408, 1_537_490.973406, 1_669_987.6063580355, 92.99634],
    ['AlphaGrowth RWA eUSDT-33', 0.0040186849302, 0, 110.15630363209499, 0.0036480476],
    ['K3 Yield eUSDC-22', 0.021893873308238165, 119_623.011958, 423_249.37329449086, 28.147542],
  ])('ignores dust bad debt on %s', (_name, badDebtUsd, openInterestUsd, supplyUsd, utilization) => {
    const input = {
      ...live,
      getCollateralGroups: () => [backing(USDC, openInterestUsd)],
      totalExposureUsd: supplyUsd,
      utilization,
      vaultShare: 1,
    }
    const display = resolveVaultExposureDisplay({ ...input, badDebtUsd })

    expect(display.items.some(item => item.kind === 'uncovered')).toBe(false)
    expect(display).toEqual(resolveVaultExposureDisplay(input))
  })

  it('still shows the uncovered debt of eBOLD-1, all of its 4.70 USD of debt', () => {
    const { items } = resolveVaultExposureDisplay({
      ...live,
      getCollateralGroups: () => [backing(SBOLD, 9.216926737779122e-18)],
      totalExposureUsd: 505.4210635310829,
      utilization: 0.92940135,
      badDebtUsd: 4.6974371328630715,
    })

    expect(valueOf(items, UNCOVERED_EXPOSURE_LABEL)).toBeCloseTo(505.4210635310829 * 0.0092940135, 6)
  })

  it('gives an Earn allocation its pro rata share of the uncovered debt', () => {
    const whole = resolveVaultExposureDisplay({ ...eusdc42, badDebtUsd: EUSDC_42_BAD_DEBT_USD })
    const share = getHeldSupplyShare(25n, 100n)
    const quarter = resolveVaultExposureDisplay({
      ...eusdc42,
      totalExposureUsd: EUSDC_42_TOTAL_SUPPLY_USD * share,
      vaultShare: share,
      badDebtUsd: EUSDC_42_BAD_DEBT_USD,
    })

    expect(share).toBe(0.25)
    expect(valueOf(quarter.items, UNCOVERED_EXPOSURE_LABEL)).toBeCloseTo(valueOf(whole.items, UNCOVERED_EXPOSURE_LABEL) / 4, 6)
    expect(valueOf(quarter.items, 'BOLD')).toBeCloseTo(valueOf(whole.items, 'BOLD') / 4, 9)
    expect(getHeldSupplyShare(25n, 0n)).toBe(0)
  })

  it('subtracts known uncovered debt from the exact single-collateral fallback', () => {
    const input = {
      openInterestEnabled: false,
      openInterestLoaded: false,
      hasOpenInterestError: false,
      totalSupplyState: 'ready' as const,
      getCollateralGroups: () => [backing(BOLD, 0)],
      acceptedCollateralCount: 1,
      totalExposureUsd: 100,
      utilization: 50,
      badDebtUsd: 30,
    }

    const { valueState, items } = resolveVaultExposureDisplay({ ...input, vaultShare: 1 })
    expect(valueState).toBe('ready')
    expect(valueOf(items, UNCOVERED_EXPOSURE_LABEL)).toBeCloseTo(30, 9)
    expect(valueOf(items, 'BOLD')).toBeCloseTo(20, 9)

    const quarter = resolveVaultExposureDisplay({ ...input, totalExposureUsd: 25, vaultShare: 0.25 })
    expect(valueOf(quarter.items, UNCOVERED_EXPOSURE_LABEL)).toBeCloseTo(7.5, 9)

    const unscaled = resolveVaultExposureDisplay(input)
    expect(unscaled.items.some(item => item.kind === 'uncovered')).toBe(false)
  })

  it('waits for the bad debt before splitting a vault with live open interest', () => {
    expect(resolveVaultExposureDisplay({ ...eusdc42, badDebtLoading: true })).toEqual({ valueState: 'loading', items: [] })
  })

  it('does not say "Backed by BOLD" when most of the debt is uncovered', () => {
    const lead = getVaultBackingLead({
      openInterestEnabled: true,
      openInterestLoaded: true,
      hasOpenInterestError: false,
      getCollateralGroups: eusdc42Groups,
      utilization: EUSDC_42_UTILIZATION,
      acceptedCollateralCount: 4,
      badDebtUsd: EUSDC_42_BAD_DEBT_USD,
    })

    expect(lead?.label).toBe('Mostly uncovered debt; rest backed by BOLD, sBOLD')
    expect(lead?.assets.map(asset => asset.symbol)).toEqual(['BOLD', 'sBOLD'])
  })

  it('keeps "Backed by" when only a minor share of the debt is uncovered', () => {
    expect(getExposureLead({
      valueState: 'ready',
      items: [
        { asset: { address: BOLD.address, symbol: 'BOLD' }, valueUsd: 90 },
        { asset: { address: '0x0000000000000000000000000000000000000000', symbol: 'Uncovered' }, label: UNCOVERED_EXPOSURE_LABEL, kind: 'uncovered', valueUsd: 10 },
      ],
    })?.label).toBe('Backed by BOLD')
  })

  it('names the uncovered debt alone and falls back to the strategy asset when nothing covers it', () => {
    const usdc = { ...USDC }
    const header = getVaultHeaderAssets(
      { utilization: 50, collaterals: [{}], asset: usdc },
      { enabled: true, loaded: true, hasError: false },
      () => [backing(SBOLD, 0)],
      { badDebtUsd: 40, openInterestTotalUsd: 0 },
    )

    expect(header).toEqual({ assets: [usdc], label: 'Mostly uncovered debt' })
  })
})
