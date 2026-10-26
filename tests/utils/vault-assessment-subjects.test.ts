import { describe, expect, it } from 'vitest'
import { getAddress } from 'viem'
import {
  collectObservedAddresses,
  formatVaultReferenceName,
  getCollateralBorrowsUsd,
  getOraclePairCollateral,
  getStrategyDepositShare,
  getVaultCheckSubject,
} from '~/utils/vault-assessment/subjects'

const strategy = '0x6fe7fa90756434645f0b0428fdff78e99dda0fbc'
const collateral = '0x55f9bace2c864ac0d3392ea9fa654b605f21a3d3'

describe('getVaultCheckSubject', () => {
  it.each([
    [`strategy.${strategy}.visible`, 'strategy', strategy],
    [`collateral.${collateral}.ltv`, 'collateral', collateral],
    [`scheduled.collateral.${collateral}.ltv`, 'collateral', collateral],
  ])('reads %s as a %s', (key, namespace, address) => {
    expect(getVaultCheckSubject(key)).toEqual({ namespace, address: getAddress(address) })
  })

  it.each(['governance.timelock', 'oracle.adapters-checks', `evidence.${strategy}`, 'collateral.not-an-address.ltv'])('has no subject for %s', (key) => {
    expect(getVaultCheckSubject(key)).toBeNull()
  })
})

describe('collectObservedAddresses', () => {
  it('finds every full address in nested evidence once', () => {
    const adapters = ['0xb62286380e2d0f9b2d2fc9975765fd272275cd39', '0x916f006ae522769badf95cf6afdb90e162cb96e6']
    expect(collectObservedAddresses({ adapters: 4, unrecognized: adapters, nested: { again: [adapters[0]] }, note: '0x1234' }))
      .toEqual(adapters)
  })

  it('ignores evidence that is not an object or a list', () => {
    expect(collectObservedAddresses(null)).toEqual([])
    expect(collectObservedAddresses('3600')).toEqual([])
  })
})

describe('getStrategyDepositShare', () => {
  const earn = {
    strategies: [
      { address: getAddress(strategy), allocatedAssets: 2_334_073_145n },
      { address: getAddress(collateral), allocatedAssets: 0n },
      { address: '0x797dd80692c3b2dadabce8e30c07fde5307d48a9', allocatedAssets: 36_675_590_166n },
    ],
  }

  it('is the strategy allocation over all allocations, as the Exposure section shows it', () => {
    expect(getStrategyDepositShare(earn, strategy)).toBeCloseTo(0.0598, 4)
  })

  it('keeps a positive share below one millionth distinct from no allocation', () => {
    const tiny = { strategies: [
      { address: strategy, allocatedAssets: 1_000_000n },
      { address: collateral, allocatedAssets: 1_999_999_000_000n },
    ] }
    expect(getStrategyDepositShare(tiny, strategy)).toBeCloseTo(0.0000005, 10)
    expect(getStrategyDepositShare(tiny, collateral)).toBeGreaterThan(0)
  })

  it('is zero for a strategy holding nothing or a vault with nothing allocated, and unknown for a removed one', () => {
    expect(getStrategyDepositShare(earn, collateral)).toBe(0)
    expect(getStrategyDepositShare({ strategies: earn.strategies.map(item => ({ ...item, allocatedAssets: 0n })) }, strategy)).toBe(0)
    expect(getStrategyDepositShare(earn, '0x0000000000000000000000000000000000000001')).toBeUndefined()
  })
})

describe('getCollateralBorrowsUsd', () => {
  it('adds the borrows a collateral backs, whatever the address case', () => {
    expect(getCollateralBorrowsUsd([{ [getAddress(collateral)]: 1200, [strategy]: 5 }, { [collateral]: 300 }], collateral)).toBe(1500)
  })

  it('is zero when the collateral backs nothing', () => {
    expect(getCollateralBorrowsUsd([{ [strategy]: 5 }], collateral)).toBe(0)
  })
})

describe('getOraclePairCollateral', () => {
  const adapter = '0x00000000000000000000000000000000000000a1'
  const liabilityAdapter = '0x00000000000000000000000000000000000000a2'
  const vault = {
    debtPricingOracleRoute: { steps: [{ kind: 'adapter', oracle: liabilityAdapter }] },
    collaterals: [
      { address: '0x00000000000000000000000000000000000000c0', borrowLTV: 0, oracleRoute: { steps: [] } },
      { address: '0x00000000000000000000000000000000000000c1', borrowLTV: 0.8, oracleRoute: { steps: [{ kind: 'adapter', oracle: '0x00000000000000000000000000000000000000a3' }] } },
      { address: '0x00000000000000000000000000000000000000c2', borrowLTV: 0.8, oracleRoute: { steps: [{ kind: 'adapter', oracle: getAddress(adapter) }] } },
    ],
  }

  it('is the collateral whose route uses the adapter', () => {
    expect(getOraclePairCollateral(vault as never, adapter)).toBe('0x00000000000000000000000000000000000000c2')
  })

  it('is a borrowable collateral for an adapter on the liability route, which every pair shows', () => {
    expect(getOraclePairCollateral(vault as never, liabilityAdapter)).toBe('0x00000000000000000000000000000000000000c1')
  })

  it('is undefined for an adapter on no route', () => {
    expect(getOraclePairCollateral(vault as never, '0x00000000000000000000000000000000000000ff')).toBeUndefined()
  })
})

describe('formatVaultReferenceName', () => {
  it('names a vault by its product and asset', () => {
    expect(formatVaultReferenceName({ productName: 'AlphaGrowth Cap', assetSymbol: 'USDC', sharesName: 'EVK Vault eUSDC-63' })).toBe('AlphaGrowth Cap USDC')
  })

  it('does not repeat an asset the product name already carries', () => {
    expect(formatVaultReferenceName({ productName: 'Prime USDC', assetSymbol: 'USDC' })).toBe('Prime USDC')
  })

  it('falls back to the share name, and names escrow by its asset', () => {
    expect(formatVaultReferenceName({ sharesName: 'EVK Vault eUSDC-63', assetSymbol: 'USDC' })).toBe('EVK Vault eUSDC-63')
    expect(formatVaultReferenceName({ escrow: true, productName: 'Escrow', assetSymbol: 'wstETH' })).toBe('Escrowed wstETH')
  })
})
