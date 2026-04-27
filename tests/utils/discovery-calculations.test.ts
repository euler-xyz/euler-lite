import { describe, expect, it, vi } from 'vitest'
import {
  STATS_ROWS,
  buildAttributeRowCells,
  getActiveExternalCollateral,
  getAttributeRowColor,
  getCollateralMatrix,
  isNodeRampingDown,
  type VaultUsdCacheEntry,
} from '~/utils/discoveryCalculations'
import type { MarketGroup } from '~/entities/lend-discovery'
import type { Vault, VaultCollateralLTV } from '~/entities/vault/types'

vi.mock('~/entities/euler/labels', () => ({
  getEulerLabelEntityLogo: () => undefined,
}))

vi.mock('~/utils/eulerLabelsUtils', () => ({
  getEntitiesByVault: () => [],
  isVaultDeprecated: () => false,
}))

const nowSeconds = BigInt(Math.floor(Date.now() / 1000))

const makeLtv = (overrides: Partial<VaultCollateralLTV> = {}): VaultCollateralLTV => ({
  collateral: '0xCollateral',
  borrowLTV: 0n,
  liquidationLTV: 7000n,
  initialLiquidationLTV: 8500n,
  targetTimestamp: nowSeconds + 1000n,
  rampDuration: 2000n,
  ...overrides,
})

const makeVault = (address: string, collateralLTVs: VaultCollateralLTV[]): Vault =>
  ({
    address,
    collateralLTVs,
    asset: { address, symbol: 'TST' },
  }) as unknown as Vault

const makeMarket = (vaults: Vault[], externalCollateral: Vault[] = []): MarketGroup =>
  ({
    vaults,
    externalCollateral,
  }) as unknown as MarketGroup

describe('isNodeRampingDown', () => {
  it('marks the vault whose own collateral LTV is ramping down after borrow LTV is zeroed', () => {
    const borrowVault = makeVault('0xBorrow', [makeLtv({ collateral: '0xCollateral' })])
    const collateralVault = makeVault('0xCollateral', [])
    const market = makeMarket([borrowVault, collateralVault])

    expect(isNodeRampingDown(market, '0xBorrow')).toBe(true)
  })

  it('does not mark a collateral vault just because another vault is ramping against it', () => {
    const borrowVault = makeVault('0xBorrow', [makeLtv({ collateral: '0xCollateral' })])
    const collateralVault = makeVault('0xCollateral', [])
    const market = makeMarket([borrowVault, collateralVault])

    expect(isNodeRampingDown(market, '0xCollateral')).toBe(false)
  })

  it('does not mark completed or upward LTV changes as ramping down', () => {
    const vault = makeVault('0xBorrow', [
      makeLtv({
        liquidationLTV: 9000n,
        initialLiquidationLTV: 8500n,
      }),
      makeLtv({
        targetTimestamp: nowSeconds - 1n,
      }),
    ])
    const market = makeMarket([vault])

    expect(isNodeRampingDown(market, '0xBorrow')).toBe(false)
  })
})

describe('getCollateralMatrix', () => {
  it('keeps a vault as a matrix column while its liquidation LTV is still ramping down', () => {
    const borrowVault = makeVault('0xBorrow', [makeLtv({ collateral: '0xCollateral', borrowLTV: 0n })])
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
        collateral: '0xCollateral',
        borrowLTV: 0n,
        liquidationLTV: 0n,
        initialLiquidationLTV: 8500n,
        targetTimestamp: nowSeconds - 1n,
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
      makeLtv({ collateral: '0xExternal', borrowLTV: 0n }),
    ])
    const externalVault = makeVault('0xExternal', [])
    const market = makeMarket([borrowVault], [externalVault])

    const active = getActiveExternalCollateral(market)
    expect(active.map(v => (v as Vault).address)).toContain('0xExternal')
  })

  it('drops an external collateral once the relationship is fully ramped out', () => {
    const borrowVault = makeVault('0xBorrow', [
      makeLtv({
        collateral: '0xExternal',
        borrowLTV: 0n,
        liquidationLTV: 0n,
        initialLiquidationLTV: 8500n,
        targetTimestamp: nowSeconds - 1n,
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
      supply: 400n,
      borrow: 500n,
      totalAssets: 1000n,
      supplyCap: 1000n,
      borrowCap: 1000n,
      interestRateInfo: {
        supplyAPY: 5n * 10n ** 25n,
        borrowAPY: 12n * 10n ** 25n,
      },
    } as Vault
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

    const columns = [{ address: vault.address.toLowerCase(), symbol: 'TST', assetAddress: vault.asset.address, vault }]
    const usdCache = new Map([[vault.address.toLowerCase(), usd]])
    const byRow = new Map(STATS_ROWS.map(row => [
      row.id,
      { row, cell: buildAttributeRowCells(row, columns, usdCache)[0] },
    ]))

    expect(byRow.get('totalSupply')!.row.direction).toBe('higher-better')
    expect(byRow.get('totalSupply')!.cell.numeric).toBe(1000)
    expect(byRow.get('totalBorrow')!.row.direction).toBe('lower-better')
    expect(byRow.get('totalBorrow')!.cell.numeric).toBe(500)
    expect(byRow.get('liquidity')!.row.direction).toBe('higher-better')
    expect(byRow.get('liquidity')!.cell.numeric).toBe(500)
    expect(byRow.get('utilization')!.row.direction).toBe('lower-better')
    expect(byRow.get('utilization')!.cell.numeric).toBe(50)
    expect(byRow.get('supplyCapUsage')!.row.direction).toBe('lower-better')
    expect(byRow.get('supplyCapUsage')!.cell.numeric).toBe(40)
    expect(byRow.get('borrowCapUsage')!.row.direction).toBe('lower-better')
    expect(byRow.get('borrowCapUsage')!.cell.numeric).toBe(50)
    expect(byRow.get('supplyApy')!.row.direction).toBe('higher-better')
    expect(byRow.get('supplyApy')!.cell.numeric).toBe(5)
    expect(byRow.get('borrowApy')!.row.direction).toBe('lower-better')
    expect(byRow.get('borrowApy')!.cell.numeric).toBe(12)
  })

  it('colors higher-better rows green at the high end and lower-better rows red at the high end', () => {
    expect(getAttributeRowColor(100, 0, 100, 'higher-better')).toContain('hsla(145')
    expect(getAttributeRowColor(100, 0, 100, 'lower-better')).toContain('hsla(0')
  })
})
