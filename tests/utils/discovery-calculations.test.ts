import { describe, expect, it, vi } from 'vitest'
import {
  STATS_ROWS,
  buildAttributeRowCells,
  buildVaultApyCache,
  getActiveExternalCollateral,
  getCollateralMatrix,
  isNodeRampingDown,
  type VaultApyCacheEntry,
  type VaultUsdCacheEntry,
} from '~/utils/discoveryCalculations'
import type { MarketGroup } from '~/entities/lend-discovery'
import type { EVault, EVaultCollateral } from '~/entities/vault/types'

vi.mock('~/entities/euler/labels', () => ({
  getEulerLabelEntityLogo: () => undefined,
}))

vi.mock('~/utils/eulerLabelsUtils', () => ({
  getEntitiesByVault: () => [],
  isVaultDeprecated: () => false,
}))

vi.stubGlobal('useVaultRegistry', () => ({
  getVaultCategory: () => undefined,
}))

const makeLtv = (overrides: Partial<any> = {}): EVaultCollateral => ({
  address: '0xCollateral',
  borrowLTV: 0,
  liquidationLTV: 0.7,
  currentLiquidationLTV: 0.75,
  isLiquidationLTVRamping: true,
  rampTimeRemaining: 1000n,
  oraclePriceRaw: {
    amountIn: 0n,
    amountOutMid: 0n,
    amountOutBid: 0n,
    amountOutAsk: 0n,
    timestamp: 0,
  },
  ...overrides,
}) as unknown as EVaultCollateral

const makeVault = (address: string, collaterals: EVaultCollateral[]): EVault =>
  ({
    address,
    collaterals,
    asset: { address, symbol: 'TST' },
  }) as unknown as EVault

const makeMarket = (vaults: EVault[], externalCollateral: EVault[] = []): MarketGroup =>
  ({
    vaults,
    externalCollateral,
  }) as unknown as MarketGroup

describe('isNodeRampingDown', () => {
  it('marks the vault whose own collateral LTV is ramping down after borrow LTV is zeroed', () => {
    const borrowVault = makeVault('0xBorrow', [makeLtv({ address: '0xCollateral' })])
    const collateralVault = makeVault('0xCollateral', [])
    const market = makeMarket([borrowVault, collateralVault])

    expect(isNodeRampingDown(market, '0xBorrow')).toBe(true)
  })

  it('does not mark a collateral vault just because another vault is ramping against it', () => {
    const borrowVault = makeVault('0xBorrow', [makeLtv({ address: '0xCollateral' })])
    const collateralVault = makeVault('0xCollateral', [])
    const market = makeMarket([borrowVault, collateralVault])

    expect(isNodeRampingDown(market, '0xCollateral')).toBe(false)
  })

  it('does not mark completed or upward LTV changes as ramping down', () => {
    const vault = makeVault('0xBorrow', [
      makeLtv({
        liquidationLTV: 0.9,
        currentLiquidationLTV: 0.9,
        isLiquidationLTVRamping: false,
      }),
      makeLtv({
        currentLiquidationLTV: 0.7,
        isLiquidationLTVRamping: false,
      }),
    ])
    const market = makeMarket([vault])

    expect(isNodeRampingDown(market, '0xBorrow')).toBe(false)
  })
})

describe('getCollateralMatrix', () => {
  it('keeps a vault as a matrix column while its liquidation LTV is still ramping down', () => {
    const borrowVault = makeVault('0xBorrow', [makeLtv({ address: '0xCollateral', borrowLTV: 0 })])
    const collateralVault = makeVault('0xCollateral', [])
    const market = makeMarket([borrowVault, collateralVault])

    const matrix = getCollateralMatrix(market)

    expect(matrix).not.toBeNull()
    expect(matrix!.columns.map(col => col.address)).toContain('0xborrow')
    expect(matrix!.rows.map(row => row.address)).toContain('0xcollateral')
  })

  it('drops a vault from matrix columns once all of its collateral relationships are fully ramped out', () => {
    const phasedOutVault = makeVault('0xBorrow', [
      makeLtv({
        address: '0xCollateral',
        borrowLTV: 0,
        liquidationLTV: 0,
        currentLiquidationLTV: 0,
        isLiquidationLTVRamping: false,
      }),
    ])
    const collateralVault = makeVault('0xCollateral', [])
    const market = makeMarket([phasedOutVault, collateralVault])

    expect(getCollateralMatrix(market)).toBeNull()
  })
})

describe('getActiveExternalCollateral', () => {
  it('keeps an external collateral vault visible while the borrow vault is ramping it out', () => {
    const borrowVault = makeVault('0xBorrow', [
      makeLtv({ address: '0xExternal', borrowLTV: 0 }),
    ])
    const externalVault = makeVault('0xExternal', [])
    const market = makeMarket([borrowVault], [externalVault])

    const active = getActiveExternalCollateral(market)
    expect(active.map(v => (v as EVault).address)).toContain('0xExternal')
  })

  it('drops an external collateral once the relationship is fully ramped out', () => {
    const borrowVault = makeVault('0xBorrow', [
      makeLtv({
        address: '0xExternal',
        borrowLTV: 0,
        liquidationLTV: 0,
        currentLiquidationLTV: 0,
        isLiquidationLTVRamping: false,
      }),
    ])
    const externalVault = makeVault('0xExternal', [])
    const market = makeMarket([borrowVault], [externalVault])

    expect(getActiveExternalCollateral(market)).toEqual([])
  })
})

describe('attribute stats matrix', () => {
  it('emits numeric values and directional rows for heatmap rendering', () => {
    const vault = {
      ...makeVault('0xStats', []),
      totalCash: 500n,
      totalBorrowed: 500n,
      totalAssets: 1000n,
      availableLiquidity: 500n,
      utilization: 50,
      caps: {
        supplyCap: 1000n,
        borrowCap: 1000n,
        supplyCapUtilization: 40,
        borrowCapUtilization: 50,
      },
      interestRates: {
        supplyAPY: 5,
        borrowAPY: 12,
      },
    } as unknown as EVault
    const usd: VaultUsdCacheEntry = {
      supply: '$1K',
      supplyUsd: 1000,
      borrow: '$500',
      borrowUsd: 500,
      liquidity: '$500',
      liquidityUsd: 500,
      supplyCap: '$1K',
      supplyCapUsd: 1000,
      borrowCap: '$1K',
      borrowCapUsd: 1000,
    }

    const columns = [{ address: vault.address.toLowerCase(), symbol: 'TST', assetAddress: vault.asset.address, vault, isExternal: false }]
    const usdCache = new Map([[vault.address.toLowerCase(), usd]])
    const byRow = new Map(STATS_ROWS.map(row => [
      row.id,
      buildAttributeRowCells(row, columns, usdCache)[0],
    ]))

    expect(byRow.get('totalSupply')!.numeric).toBe(1000)
    expect(byRow.get('totalBorrow')!.numeric).toBe(500)
    expect(byRow.get('liquidity')!.numeric).toBe(500)
    expect(byRow.get('utilization')!.numeric).toBe(50)
    expect(byRow.get('supplyCapUsage')!.numeric).toBe(40)
    expect(byRow.get('borrowCapUsage')!.numeric).toBe(50)
    expect(byRow.get('supplyApy')!.numeric).toBe(5)
    expect(byRow.get('borrowApy')!.numeric).toBe(12)
  })

  it('uses the apy cache (intrinsic + rewards) for supply/borrow APY when supplied', () => {
    const vault = {
      ...makeVault('0xApy', []),
      supply: 0n,
      borrow: 0n,
      totalAssets: 0n,
      supplyCap: 1000n,
      borrowCap: 1000n,
      interestRateInfo: {
        // Raw IRM rate the matrix would have shown before this fix.
        supplyAPY: 0n,
        borrowAPY: 0n,
      },
    } as Vault
    const columns = [{ address: vault.address.toLowerCase(), symbol: 'TST', assetAddress: vault.asset.address, vault, isExternal: false }]
    const usdCache = new Map<string, VaultUsdCacheEntry>()
    const apyCache = new Map<string, VaultApyCacheEntry>([
      [vault.address.toLowerCase(), { supplyApy: 5.31, borrowApy: 1.25 }],
    ])
    const byRow = new Map(STATS_ROWS.map(row => [
      row.id,
      buildAttributeRowCells(row, columns, usdCache, apyCache)[0],
    ]))

    expect(byRow.get('supplyApy')!.numeric).toBeCloseTo(5.31)
    expect(byRow.get('supplyApy')!.display).toBe('5.31%')
    expect(byRow.get('borrowApy')!.numeric).toBeCloseTo(1.25)
    expect(byRow.get('borrowApy')!.display).toBe('1.25%')
  })
})

describe('buildVaultApyCache', () => {
  it('folds intrinsic and reward APY into the per-vault entries', () => {
    const vault = {
      ...makeVault('0xPT', []),
      interestRateInfo: {
        supplyAPY: 4n * 10n ** 25n,
        borrowAPY: 6n * 10n ** 25n,
      },
    } as Vault
    const market = makeMarket([vault])

    const cache = buildVaultApyCache(
      [market],
      (apy, _addr) => apy + 1, // intrinsic supply contribution: +1
      (apy, _addr) => apy + 2, // intrinsic borrow contribution: +2
      _addr => 0.5, // supply rewards
      _addr => 0.25, // general borrow rewards
    )

    const entry = cache.get(vault.address.toLowerCase())
    expect(entry).toBeDefined()
    expect(entry!.supplyApy).toBeCloseTo(4 + 1 + 0.5)
    expect(entry!.borrowApy).toBeCloseTo(6 + 2 - 0.25)
  })

  it('caches external-collateral vaults so attribute matrix externals match the per-vault card', () => {
    // External EVK vaults render as columns in the attribute matrix and need
    // the same intrinsic + rewards adjustment as members — without this, the
    // Stats column would silently fall back to raw IRM for externals.
    const externalVault = {
      ...makeVault('0xExternalApy', []),
      interestRateInfo: {
        supplyAPY: 3n * 10n ** 25n,
        borrowAPY: 5n * 10n ** 25n,
      },
    } as Vault
    const market = makeMarket([], [externalVault])

    const cache = buildVaultApyCache(
      [market],
      (apy, _addr) => apy + 1,
      (apy, _addr) => apy + 2,
      _addr => 0.5,
      _addr => 0.25,
    )

    const entry = cache.get(externalVault.address.toLowerCase())
    expect(entry).toBeDefined()
    expect(entry!.supplyApy).toBeCloseTo(3 + 1 + 0.5)
    expect(entry!.borrowApy).toBeCloseTo(5 + 2 - 0.25)
  })
})
