import { describe, expect, it, vi } from 'vitest'
import {
  CONFIG_ROWS,
  STATS_ROWS,
  buildAttributeRowCells,
  buildVaultApyCache,
  getActiveExternalCollateral,
  getAttributeMatrixColumns,
  getCollateralMatrix,
  getMarketEntities,
  isNodeRampingDown,
  type VaultApyCacheEntry,
  type VaultUsdCacheEntry,
} from '~/utils/discoveryCalculations'
import type { VaultBadDebtCacheEntry } from '~/utils/vault-bad-debt'
import type { MarketGroup } from '~/entities/lend-discovery'
import type { EVault, EVaultCollateral, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { VaultRewardInfo } from '@eulerxyz/euler-v2-sdk'

vi.mock('~/entities/euler/labels', () => ({
  getEulerLabelEntityLogo: (logo: string) => `/entities/${logo}`,
}))

vi.mock('~/utils/eulerLabelsUtils', () => ({
  getEntitiesByVault: (vault: { address?: string }) => {
    if (vault.address === '0xBorrow') return [{ name: 'KPK', logo: 'kpk.svg' }]
    if (vault.address === '0xSecuritize') return [{ name: 'Securitize', logo: 'securitize.png' }]
    return []
  },
  isVaultCyclicalNote: () => false,
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
    type: 'EVault',
    address,
    collaterals,
    asset: { address, symbol: 'TST' },
    totalAssets: 0n,
    totalBorrowed: 0n,
    caps: {
      supplyCap: 0n,
      borrowCap: 0n,
      supplyCapUtilization: 0,
      borrowCapUtilization: 0,
    },
    fees: {
      interestFee: 0,
    },
    liquidation: {
      maxLiquidationDiscount: 0,
      socializeDebt: true,
    },
    hooks: {
      hookedOperations: 0n,
    },
    interestRateModel: {
      type: 0,
      address: '0xIrm',
    },
    interestRates: {
      supplyAPY: 0,
      borrowAPY: 0,
    },
  }) as unknown as EVault

const makeSecuritizeVault = (address: string): SecuritizeCollateralVault =>
  ({
    type: 'SecuritizeCollateral',
    address,
    asset: { address, symbol: 'NOTE' },
  }) as unknown as SecuritizeCollateralVault

const makeMarket = (
  vaults: Array<EVault | SecuritizeCollateralVault>,
  externalCollateral: Array<EVault | SecuritizeCollateralVault> = [],
): MarketGroup =>
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

  it('includes Securitize member vaults referenced as collateral rows', () => {
    const borrowVault = makeVault('0xBorrow', [
      makeLtv({ address: '0xSecuritize', borrowLTV: 0.5 }),
    ])
    const securitizeVault = makeSecuritizeVault('0xSecuritize')
    const market = makeMarket([borrowVault, securitizeVault])

    const matrix = getCollateralMatrix(market)

    expect(matrix).not.toBeNull()
    expect(matrix!.rows).toContainEqual({
      address: '0xsecuritize',
      symbol: 'NOTE',
      assetAddress: '0xSecuritize',
      category: 'external',
    })
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
  it('includes Securitize member vaults in attribute columns', () => {
    const eVault = makeVault('0xBorrow', [])
    const securitizeVault = makeSecuritizeVault('0xSecuritize')
    const market = makeMarket([eVault, securitizeVault])

    expect(getAttributeMatrixColumns(market).map(column => column.address)).toEqual([
      '0xborrow',
      '0xsecuritize',
    ])
  })

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
    expect(byRow.get('badDebt')!.display).toBe('—')
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
    } as unknown as EVault
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

  it('uses the bad debt cache for borrowable vault stats', () => {
    const vault = {
      ...makeVault('0xBadDebt', []),
      totalAssets: 1000n,
      totalBorrowed: 500n,
      liquidation: { socializeDebt: true },
    } as unknown as EVault
    const columns = [{ address: vault.address.toLowerCase(), symbol: 'TST', assetAddress: vault.asset.address, vault, isExternal: false }]
    const usdCache = new Map<string, VaultUsdCacheEntry>([
      [vault.address.toLowerCase(), {
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
      }],
    ])
    const badDebtCache = new Map<string, VaultBadDebtCacheEntry>([
      [vault.address.toLowerCase(), {
        badDebtUsd: 125,
        debtUsd: 150,
        collateralUsd: 25,
        coveredDebtUsd: 25,
        accountCount: 2,
        calculationTimestamp: '2026-06-25T10:14:59.000Z',
        priceTimestamp: '2026-06-25T10:14:24.994Z',
        refreshedAt: '2026-06-25T10:15:08.039Z',
      }],
    ])

    const row = STATS_ROWS.find(row => row.id === 'badDebt')!
    const cell = buildAttributeRowCells(row, columns, usdCache, undefined, badDebtCache)[0]

    expect(cell.display).toBe('$125')
    expect(cell.numeric).toBe(125)
    expect(cell.hint).toContain('25% of total borrows')
    expect(cell.hint).toContain('2 underwater accounts')
  })
})

describe('getMarketEntities', () => {
  it('includes Securitize product members when deriving market risk managers', () => {
    const borrowVault = makeVault('0xBorrow', [])
    const securitizeVault = makeSecuritizeVault('0xSecuritize')
    const market = makeMarket([borrowVault, securitizeVault])

    expect(getMarketEntities(market)).toEqual({
      name: 'KPK & Securitize',
      logos: ['/entities/kpk.svg', '/entities/securitize.png'],
    })
  })
})

describe('attribute config matrix', () => {
  it('formats SDK fractional fee and liquidation discount values as percentages', () => {
    const vault = {
      ...makeVault('0xConfig', []),
      caps: {
        supplyCap: 1000n,
        borrowCap: 1000n,
      },
      fees: {
        interestFee: 0.1,
      },
      liquidation: {
        maxLiquidationDiscount: 0.15,
        socializeDebt: true,
      },
      interestRateModel: {
        type: 0,
        address: '0xIrm',
      },
    } as unknown as EVault
    const columns = [{ address: vault.address.toLowerCase(), symbol: 'TST', assetAddress: vault.asset.address, vault, isExternal: false }]
    const usdCache = new Map<string, VaultUsdCacheEntry>()
    const byRow = new Map(CONFIG_ROWS.map(row => [
      row.id,
      buildAttributeRowCells(row, columns, usdCache)[0],
    ]))

    expect(byRow.get('interestFee')!.display).toBe('10.00%')
    expect(byRow.get('maxLiqDiscount')!.display).toBe('15%')
  })
})

describe('buildVaultApyCache', () => {
  const settings = { enableIntrinsicApy: true, enableRewardsApy: true }
  // 0.5% supply + 0.25% borrow campaigns expressed as VaultRewardInfo;
  // c.apr is a decimal fraction, so 0.5% = 0.005.
  const rewards = () => new VaultRewardInfo({
    campaigns: [
      {
        campaignId: 'lend',
        source: 'merkl',
        action: 'LEND',
        apr: 0.005,
        rewardTokenSymbol: 'EUL',
      },
      {
        campaignId: 'borrow',
        source: 'merkl',
        action: 'BORROW',
        apr: 0.0025,
        rewardTokenSymbol: 'EUL',
      },
    ] as never,
  })

  it('folds intrinsic and reward APY into the per-vault entries', () => {
    const vault = {
      ...makeVault('0xPT', []),
      interestRates: {
        supplyAPY: 4,
        borrowAPY: 6,
      },
      intrinsicApy: { apy: 1, provider: 'test' },
      rewards: rewards(),
    } as unknown as EVault
    const market = makeMarket([vault])

    const cache = buildVaultApyCache([market], undefined, settings)

    const entry = cache.get(vault.address.toLowerCase())
    expect(entry).toBeDefined()
    // computeSupplyApyBreakdown: lending + intrinsic + rewards = base + (1 + base/100) * intrinsic + lendRewards
    expect(entry!.supplyApy).toBeCloseTo(4 + (1 + 4 / 100) * 1 + 0.5)
    // computeBorrowApy: base + (1 + base/100) * intrinsic - borrowRewards
    expect(entry!.borrowApy).toBeCloseTo(6 + (1 + 6 / 100) * 1 - 0.25)
  })

  it('caches external-collateral vaults so attribute matrix externals match the per-vault card', () => {
    // External EVK vaults render as columns in the attribute matrix and need
    // the same intrinsic + rewards adjustment as members — without this, the
    // Stats column would silently fall back to raw IRM for externals.
    const externalVault = {
      ...makeVault('0xExternalApy', []),
      interestRates: {
        supplyAPY: 3,
        borrowAPY: 5,
      },
      intrinsicApy: { apy: 1, provider: 'test' },
      rewards: rewards(),
    } as unknown as EVault
    const market = makeMarket([], [externalVault])

    const cache = buildVaultApyCache([market], undefined, settings)

    const entry = cache.get(externalVault.address.toLowerCase())
    expect(entry).toBeDefined()
    expect(entry!.supplyApy).toBeCloseTo(3 + (1 + 3 / 100) * 1 + 0.5)
    expect(entry!.borrowApy).toBeCloseTo(5 + (1 + 5 / 100) * 1 - 0.25)
  })
})
