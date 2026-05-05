import { describe, it, expect } from 'vitest'
import { INTEREST_RATE_MODEL_TYPE } from '~/entities/constants'
import {
  getCashLimitedWithdrawAmount,
  getBorrowVaultsByMap,
  isCyclicalNoteVault,
} from '~/entities/vault/utils'
import type { EVault, EulerEarn, SecuritizeCollateralVault } from '~/entities/vault/types'

describe('getCashLimitedWithdrawAmount', () => {
  const evkVault = (availableLiquidity: bigint) => ({ type: 'EVault', availableLiquidity } as EVault)
  const securitizeVault = (totalAssets: bigint) =>
    ({ type: 'SecuritizeCollateral', totalAssets } as SecuritizeCollateralVault)
  const earnVault = (availableAssets: bigint) =>
    ({ type: 'EulerEarn', availableAssets } as EulerEarn)

  it('returns the user withdrawable amount when EVault liquidity is higher', () => {
    expect(getCashLimitedWithdrawAmount(1_000n, evkVault(2_000n))).toBe(1_000n)
  })

  it('caps the amount to EVault available liquidity when liquidity is lower', () => {
    expect(getCashLimitedWithdrawAmount(2_000n, evkVault(1_000n))).toBe(1_000n)
  })

  it('returns the user amount when the vault is undefined', () => {
    expect(getCashLimitedWithdrawAmount(2_000n, undefined)).toBe(2_000n)
  })

  it('caps SecuritizeCollateralVault by totalAssets', () => {
    expect(getCashLimitedWithdrawAmount(2_000n, securitizeVault(1_000n))).toBe(1_000n)
    expect(getCashLimitedWithdrawAmount(500n, securitizeVault(1_000n))).toBe(500n)
  })

  it('caps EulerEarn by availableAssets', () => {
    expect(getCashLimitedWithdrawAmount(2_000n, earnVault(1_000n))).toBe(1_000n)
    expect(getCashLimitedWithdrawAmount(500n, earnVault(1_000n))).toBe(500n)
  })

  it('models the withdraw form cap when vault cash is lower than user balance', () => {
    const assetsBalance = 1_000n
    const vault = evkVault(300n)
    const amount = 301n
    const withdrawableAssets = getCashLimitedWithdrawAmount(assetsBalance, vault)

    expect(withdrawableAssets).toBe(300n)
    expect(assetsBalance < amount).toBe(false)
    expect(withdrawableAssets < amount).toBe(true)
  })

  it('models the withdraw form allowing the cash-capped max amount', () => {
    const assetsBalance = 1_000n
    const vault = evkVault(300n)
    const amount = 300n
    const withdrawableAssets = getCashLimitedWithdrawAmount(assetsBalance, vault)

    expect(withdrawableAssets).toBe(amount)
    expect(withdrawableAssets < amount).toBe(false)
  })
})

describe('getBorrowVaultsByMap', () => {
  const makeVault = (address: string, collaterals: Array<{ address: string, borrowLTV: number, liquidationLTV: number, initialLiquidationLTV: number, targetTimestamp: number, rampDuration: bigint }>) =>
    ({ address, collaterals }) as unknown as EVault

  it('returns empty array for empty map', () => {
    expect(getBorrowVaultsByMap(new Map())).toEqual([])
  })

  it('returns pairs for vaults with borrowLTV > 0', () => {
    const vaultA = makeVault('0xA', [{
      address: '0xB',
      borrowLTV: 0.8,
      liquidationLTV: 0.85,
      initialLiquidationLTV: 0.85,
      targetTimestamp: 0,
      rampDuration: 0n,
    }])
    const vaultB = makeVault('0xB', [])
    const map = new Map([['0xA', vaultA], ['0xB', vaultB]])
    const pairs = getBorrowVaultsByMap(map)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].borrow).toBe(vaultA)
    expect(pairs[0].collateral).toBe(vaultB)
    expect(pairs[0].ltv.borrowLTV).toBe(0.8)
  })

  it('skips LTVs with borrowLTV = 0', () => {
    const vault = makeVault('0xA', [{
      address: '0xB',
      borrowLTV: 0,
      liquidationLTV: 0,
      initialLiquidationLTV: 0,
      targetTimestamp: 0,
      rampDuration: 0n,
    }])
    const map = new Map([['0xA', vault]])
    expect(getBorrowVaultsByMap(map)).toEqual([])
  })

  it('filters out pairs where collateral vault is not in map', () => {
    const vault = makeVault('0xA', [{
      address: '0xMissing',
      borrowLTV: 0.8,
      liquidationLTV: 0.85,
      initialLiquidationLTV: 0.85,
      targetTimestamp: 0,
      rampDuration: 0n,
    }])
    const map = new Map([['0xA', vault]])
    // Collateral vault not in map → pair.collateral is undefined → filtered
    expect(getBorrowVaultsByMap(map)).toEqual([])
  })
})

describe('isCyclicalNoteVault', () => {
  it('returns true for EVK vaults using the fixed cyclical IRM', () => {
    const vault = {
      interestRateModel: {
        type: INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY,
      },
    } as unknown as EVault

    expect(isCyclicalNoteVault(vault)).toBe(true)
  })

  it('returns false for non-cyclical EVK vaults', () => {
    const vault = {
      interestRateModel: {
        type: INTEREST_RATE_MODEL_TYPE.KINK,
      },
    } as unknown as EVault

    expect(isCyclicalNoteVault(vault)).toBe(false)
  })

  it('returns false for securitize vaults and missing vault data', () => {
    const securitizeVault = {
      type: 'SecuritizeCollateral',
    } as SecuritizeCollateralVault

    expect(isCyclicalNoteVault(securitizeVault)).toBe(false)
    expect(isCyclicalNoteVault(null)).toBe(false)
    expect(isCyclicalNoteVault(undefined)).toBe(false)
  })

  it('returns false when the IRM type is missing or not numeric', () => {
    const missingType = {
      interestRateModel: {},
    } as unknown as EVault

    const stringType = {
      interestRateModel: {
        type: `${INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY}`,
      },
    } as unknown as EVault

    expect(isCyclicalNoteVault(missingType)).toBe(false)
    expect(isCyclicalNoteVault(stringType)).toBe(false)
  })
})
