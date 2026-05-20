import { describe, it, expect } from 'vitest'
import { INTEREST_RATE_MODEL_TYPE } from '~/entities/constants'
import {
  getCashLimitedWithdrawAmount,
  getUtilization,
  getVaultUtilization,
  getBorrowVaultsByMap,
  isCyclicalNoteVault,
} from '~/entities/vault/utils'
import type { Vault, SecuritizeVault, EarnVault } from '~/entities/vault/types'

describe('getUtilization', () => {
  it('returns 0 when totalAssets is zero', () => {
    expect(getUtilization(0n, 100n)).toBe(0)
  })

  it('returns 0 when totalBorrow is zero', () => {
    expect(getUtilization(1000n, 0n)).toBe(0)
  })

  it('returns 0 when totalAssets is negative', () => {
    expect(getUtilization(-1n, 100n)).toBe(0)
  })

  it('returns 0 when totalBorrow is negative', () => {
    expect(getUtilization(1000n, -1n)).toBe(0)
  })

  it('calculates utilization correctly', () => {
    // borrow=750, assets=1000 → 75%
    expect(getUtilization(1000n, 750n)).toBe(75)
  })

  it('handles 100% utilization', () => {
    expect(getUtilization(1000n, 1000n)).toBe(100)
  })

  it('handles utilization above 100%', () => {
    // Can happen due to interest accrual
    expect(getUtilization(1000n, 1200n)).toBe(120)
  })

  it('rounds to 2 decimal places', () => {
    expect(getUtilization(1000n, 333n)).toBe(33.3)
  })

  it('handles large bigint values', () => {
    const large = 10n ** 18n
    const borrow = 75n * 10n ** 16n // 75% of 10^18
    expect(getUtilization(large, borrow)).toBe(75)
  })
})

describe('getVaultUtilization', () => {
  it('delegates to getUtilization with vault fields', () => {
    const vault = { totalAssets: 1000n, borrow: 750n } as Vault
    expect(getVaultUtilization(vault)).toBe(75)
  })

  it('returns 0 for vault with no borrows', () => {
    const vault = { totalAssets: 1000n, borrow: 0n } as Vault
    expect(getVaultUtilization(vault)).toBe(0)
  })
})

describe('getCashLimitedWithdrawAmount', () => {
  const evkVault = (totalCash: bigint) => ({ totalCash } as Vault)
  const securitizeVault = (totalAssets: bigint) =>
    ({ type: 'securitize', totalAssets } as unknown as SecuritizeVault)
  const earnVault = (availableAssets: bigint) =>
    ({ type: 'earn', availableAssets } as unknown as EarnVault)

  it('returns the user withdrawable amount when EVK cash is higher', () => {
    expect(getCashLimitedWithdrawAmount(1_000n, evkVault(2_000n))).toBe(1_000n)
  })

  it('caps the amount to EVK totalCash when cash is lower', () => {
    expect(getCashLimitedWithdrawAmount(2_000n, evkVault(1_000n))).toBe(1_000n)
  })

  it('returns the user amount when the vault is undefined', () => {
    expect(getCashLimitedWithdrawAmount(2_000n, undefined)).toBe(2_000n)
  })

  it('caps SecuritizeVault by totalAssets (no borrowing on these vaults)', () => {
    expect(getCashLimitedWithdrawAmount(2_000n, securitizeVault(1_000n))).toBe(1_000n)
    expect(getCashLimitedWithdrawAmount(500n, securitizeVault(1_000n))).toBe(500n)
  })

  it('caps EarnVault by availableAssets (strategies may have allocated cash out)', () => {
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
  const makeVault = (address: string, collateralLTVs: Array<{ collateral: string, borrowLTV: bigint, liquidationLTV: bigint, initialLiquidationLTV: bigint, targetTimestamp: bigint, rampDuration: bigint }>) =>
    ({ address, collateralLTVs }) as unknown as Vault

  it('returns empty array for empty map', () => {
    expect(getBorrowVaultsByMap(new Map())).toEqual([])
  })

  it('returns pairs for vaults with borrowLTV > 0', () => {
    const vaultA = makeVault('0xA', [{
      collateral: '0xB',
      borrowLTV: 8000n,
      liquidationLTV: 8500n,
      initialLiquidationLTV: 8500n,
      targetTimestamp: 0n,
      rampDuration: 0n,
    }])
    const vaultB = makeVault('0xB', [])
    const map = new Map([['0xA', vaultA], ['0xB', vaultB]])
    const pairs = getBorrowVaultsByMap(map)
    expect(pairs).toHaveLength(1)
    expect(pairs[0].borrow).toBe(vaultA)
    expect(pairs[0].collateral).toBe(vaultB)
    expect(pairs[0].borrowLTV).toBe(8000n)
  })

  it('skips LTVs with borrowLTV = 0', () => {
    const vault = makeVault('0xA', [{
      collateral: '0xB',
      borrowLTV: 0n,
      liquidationLTV: 0n,
      initialLiquidationLTV: 0n,
      targetTimestamp: 0n,
      rampDuration: 0n,
    }])
    const map = new Map([['0xA', vault]])
    expect(getBorrowVaultsByMap(map)).toEqual([])
  })

  it('filters out pairs where collateral vault is not in map', () => {
    const vault = makeVault('0xA', [{
      collateral: '0xMissing',
      borrowLTV: 8000n,
      liquidationLTV: 8500n,
      initialLiquidationLTV: 8500n,
      targetTimestamp: 0n,
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
      irmInfo: {
        interestRateModelInfo: {
          interestRateModelType: INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY,
        },
      },
    } as Vault

    expect(isCyclicalNoteVault(vault)).toBe(true)
  })

  it('returns false for non-cyclical EVK vaults', () => {
    const vault = {
      irmInfo: {
        interestRateModelInfo: {
          interestRateModelType: INTEREST_RATE_MODEL_TYPE.KINK,
        },
      },
    } as Vault

    expect(isCyclicalNoteVault(vault)).toBe(false)
  })

  it('returns false for securitize vaults and missing vault data', () => {
    const securitizeVault = {
      type: 'securitize',
    } as SecuritizeVault

    expect(isCyclicalNoteVault(securitizeVault)).toBe(false)
    expect(isCyclicalNoteVault(null)).toBe(false)
    expect(isCyclicalNoteVault(undefined)).toBe(false)
  })

  it('returns false when the IRM type is missing or not numeric', () => {
    const missingType = {
      irmInfo: {
        interestRateModelInfo: {},
      },
    } as Vault

    const stringType = {
      irmInfo: {
        interestRateModelInfo: {
          interestRateModelType: `${INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY}` as unknown as number,
        },
      },
    } as Vault

    expect(isCyclicalNoteVault(missingType)).toBe(false)
    expect(isCyclicalNoteVault(stringType)).toBe(false)
  })
})
