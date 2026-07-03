import { describe, expect, it } from 'vitest'
import {
  buildOpenInterestModel,
  findOpenInterestMapForVault,
  groupCollateralOpenInterestByBackingAsset,
  summarizeCollateralOpenInterest,
} from '~/utils/vault/open-interest'

describe('open interest utilities', () => {
  it('finds collateral exposure maps case-insensitively', () => {
    const vault = '0x0000000000000000000000000000000000000001'
    const collateral = '0x0000000000000000000000000000000000000002'

    expect(findOpenInterestMapForVault({
      '0x0000000000000000000000000000000000000001': {
        [collateral]: 123,
      },
    }, vault.toUpperCase())).toEqual({
      [collateral]: 123,
    })
  })

  it('sorts collateral exposure and collapses the tail into Other', () => {
    const summarized = summarizeCollateralOpenInterest([
      { address: 'a', label: 'A', valueUsd: 10 },
      { address: 'b', label: 'B', valueUsd: 50 },
      { address: 'c', label: 'C', valueUsd: 30 },
      { address: 'd', label: 'D', valueUsd: 20 },
    ], 3)

    expect(summarized).toEqual([
      { address: 'b', label: 'B', valueUsd: 50 },
      { address: 'c', label: 'C', valueUsd: 30 },
      { address: 'other', label: 'Other', valueUsd: 30, vaultCount: 2 },
    ])
  })

  it('groups duplicate collateral vaults by backing asset', () => {
    const grouped = groupCollateralOpenInterestByBackingAsset([
      { address: '0x0000000000000000000000000000000000000001', backingAssetAddress: '0x000000000000000000000000000000000000000a', label: 'USDC', valueUsd: 10 },
      { address: '0x0000000000000000000000000000000000000002', backingAssetAddress: '0x000000000000000000000000000000000000000a', label: 'USDC', valueUsd: 15 },
      { address: '0x0000000000000000000000000000000000000003', backingAssetAddress: '0x000000000000000000000000000000000000000b', label: 'WETH', valueUsd: 5 },
    ])

    expect(grouped).toEqual([
      {
        address: '0x000000000000000000000000000000000000000a',
        backingAssetAddress: '0x000000000000000000000000000000000000000a',
        label: 'USDC',
        valueUsd: 25,
        vaultCount: 2,
      },
      {
        address: '0x000000000000000000000000000000000000000b',
        backingAssetAddress: '0x000000000000000000000000000000000000000b',
        label: 'WETH',
        valueUsd: 5,
        vaultCount: 1,
      },
    ])
  })

  it('builds right-side cash and borrowed composition percentages', () => {
    const model = buildOpenInterestModel({
      collaterals: [
        { address: 'a', label: 'A', valueUsd: 75 },
        { address: 'b', label: 'B', valueUsd: 25 },
      ],
      cashUsd: 40,
      borrowedUsd: 60,
    })

    expect(model.collateralNodes.map(node => node.percentage)).toEqual([75, 25])
    expect(model.rightNodes.borrowed.percentage).toBe(60)
    expect(model.rightNodes.cash.percentage).toBe(40)
    expect(model.flows).toHaveLength(2)
    expect(model.totalUsd).toBe(100)
  })
})
