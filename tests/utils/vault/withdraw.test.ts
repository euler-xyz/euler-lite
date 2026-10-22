import { describe, expect, it } from 'vitest'
import type { EVault, EulerEarn, IAccountLiquidity, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import {
  getBorrowLtvWithdrawLimit,
  getBorrowLtvWithdrawNotice,
  getCashLimitedWithdrawAmount,
  isAtBorrowLtvLimit,
} from '~/utils/vault/withdraw'

const COLLATERAL = '0x64a3052570F5A1c241C6c8cd32F8F9aD411e6990'
const OTHER_COLLATERAL = '0x97d30B40048bA3fC6b6628cE5E02E77f35B64fE0'
const WAD = 10n ** 18n

const valueOf = (borrowing: bigint, oracleMid = borrowing) => ({ borrowing, liquidation: borrowing, oracleMid })

const makeLiquidity = ({
  liability,
  collaterals,
}: {
  liability: bigint
  collaterals: { address: string, borrowing: bigint }[]
}): IAccountLiquidity => ({
  vaultAddress: '0xF9BB65e113418292d1a3555515fBd64637a0BE18',
  unitOfAccount: '0x0000000000000000000000000000000000000348',
  daysToLiquidation: 'Infinity',
  liabilityValue: valueOf(liability),
  totalCollateralValue: valueOf(collaterals.reduce((sum, c) => sum + c.borrowing, 0n)),
  collaterals: collaterals.map(c => ({ address: c.address as `0x${string}`, value: valueOf(c.borrowing) })),
})

// HyperEVM eUSDC-4 borrower against ewstHYPE-1 after the curator set wstHYPE's borrow LTV to 0 (block 49171409, 2026-10-22).
const zeroBorrowLtvLiquidity = makeLiquidity({
  liability: 922_954_093_495_824_040_000n,
  collaterals: [{ address: COLLATERAL, borrowing: 0n }],
})
const ZERO_LTV_COLLATERAL_ASSETS = 1_209_046_913_888_095_771_537n

describe('getBorrowLtvWithdrawLimit', () => {
  it('returns undefined when liquidity is unavailable', () => {
    expect(getBorrowLtvWithdrawLimit({
      liquidity: undefined,
      collateralAddress: COLLATERAL,
      collateralAssets: 100n * WAD,
    })).toBeUndefined()
  })

  it('allows the full balance when there is no liability', () => {
    expect(getBorrowLtvWithdrawLimit({
      liquidity: makeLiquidity({ liability: 0n, collaterals: [{ address: COLLATERAL, borrowing: 8_000n * WAD }] }),
      collateralAddress: COLLATERAL,
      collateralAssets: 100n * WAD,
    })).toBe(100n * WAD)
  })

  it('allows nothing when the only collateral has a borrow LTV of 0', () => {
    expect(getBorrowLtvWithdrawLimit({
      liquidity: zeroBorrowLtvLiquidity,
      collateralAddress: COLLATERAL,
      collateralAssets: ZERO_LTV_COLLATERAL_ASSETS,
    })).toBe(0n)
  })

  it('allows the full balance of a zero borrow LTV collateral when other collateral covers the debt', () => {
    expect(getBorrowLtvWithdrawLimit({
      liquidity: makeLiquidity({
        liability: 1_000n * WAD,
        collaterals: [
          { address: COLLATERAL, borrowing: 0n },
          { address: OTHER_COLLATERAL, borrowing: 5_000n * WAD },
        ],
      }),
      collateralAddress: COLLATERAL,
      collateralAssets: 100n * WAD,
    })).toBe(100n * WAD)
  })

  it.each([1_000n * WAD + 1n, 1_005n * WAD, 1_010n * WAD])(
    'allows all zero-value collateral when other borrowing value is %s, inside or at the margin',
    (otherBorrowingValue) => {
      const liquidity = makeLiquidity({
        liability: 1_000n * WAD,
        collaterals: [
          { address: COLLATERAL, borrowing: 0n },
          { address: OTHER_COLLATERAL, borrowing: otherBorrowingValue },
        ],
      })

      expect(getBorrowLtvWithdrawLimit({
        liquidity,
        collateralAddress: COLLATERAL,
        collateralAssets: 100n * WAD,
      })).toBe(100n * WAD)
      expect(getBorrowLtvWithdrawNotice({
        liquidity,
        collateralAddress: COLLATERAL,
        collateralBorrowLTV: 0,
        symbol: 'wstHYPE',
      })).toBeNull()
    },
  )

  it.each([999n * WAD, 1_000n * WAD])(
    'blocks zero-value collateral when other borrowing value is %s and does not exceed the liability',
    (otherBorrowingValue) => {
      expect(getBorrowLtvWithdrawLimit({
        liquidity: makeLiquidity({
          liability: 1_000n * WAD,
          collaterals: [
            { address: COLLATERAL, borrowing: 0n },
            { address: OTHER_COLLATERAL, borrowing: otherBorrowingValue },
          ],
        }),
        collateralAddress: COLLATERAL,
        collateralAssets: 100n * WAD,
      })).toBe(0n)
    },
  )

  it('caps the amount so the borrow-adjusted collateral value keeps a 1% margin over the liability', () => {
    const limit = getBorrowLtvWithdrawLimit({
      liquidity: makeLiquidity({ liability: 4_000n * WAD, collaterals: [{ address: COLLATERAL, borrowing: 8_000n * WAD }] }),
      collateralAddress: COLLATERAL,
      collateralAssets: 100n * WAD,
    })

    expect(limit).toBe(49_500n * 10n ** 15n)
    const remainingBorrowingValue = 8_000n * WAD * (100n * WAD - limit!) / (100n * WAD)
    expect(remainingBorrowingValue >= 4_040n * WAD).toBe(true)
  })

  it('allows nothing inside the margin even though the position is not at its limit', () => {
    expect(getBorrowLtvWithdrawLimit({
      liquidity: makeLiquidity({ liability: 4_000n * WAD, collaterals: [{ address: COLLATERAL, borrowing: 4_020n * WAD }] }),
      collateralAddress: COLLATERAL,
      collateralAssets: 100n * WAD,
    })).toBe(0n)
  })

  it('rounds the margin up so a dust liability still stays strictly covered', () => {
    expect(getBorrowLtvWithdrawLimit({
      liquidity: makeLiquidity({ liability: 1n, collaterals: [{ address: COLLATERAL, borrowing: 3n }] }),
      collateralAddress: COLLATERAL,
      collateralAssets: 3n,
    })).toBe(1n)
  })

  it('rounds the limit down when the division is inexact', () => {
    expect(getBorrowLtvWithdrawLimit({
      liquidity: makeLiquidity({ liability: 1_000n * WAD, collaterals: [{ address: COLLATERAL, borrowing: 3_000n * WAD }] }),
      collateralAddress: COLLATERAL,
      collateralAssets: 7n,
    })).toBe(4n)
  })

  it('allows the full balance of a collateral the account check does not value', () => {
    expect(getBorrowLtvWithdrawLimit({
      liquidity: makeLiquidity({ liability: 1_000n * WAD, collaterals: [{ address: OTHER_COLLATERAL, borrowing: 5_000n * WAD }] }),
      collateralAddress: COLLATERAL,
      collateralAssets: 100n * WAD,
    })).toBe(100n * WAD)
  })

  it('allows nothing when the position is already at its borrow limit', () => {
    expect(getBorrowLtvWithdrawLimit({
      liquidity: makeLiquidity({ liability: 8_000n * WAD, collaterals: [{ address: COLLATERAL, borrowing: 8_000n * WAD }] }),
      collateralAddress: COLLATERAL,
      collateralAssets: 100n * WAD,
    })).toBe(0n)
  })

  it('never exceeds the collateral balance', () => {
    expect(getBorrowLtvWithdrawLimit({
      liquidity: makeLiquidity({
        liability: 1_000n * WAD,
        collaterals: [
          { address: COLLATERAL, borrowing: 500n * WAD },
          { address: OTHER_COLLATERAL, borrowing: 50_000n * WAD },
        ],
      }),
      collateralAddress: COLLATERAL,
      collateralAssets: 10n * WAD,
    })).toBe(10n * WAD)
  })

  it('matches the collateral address case-insensitively', () => {
    expect(getBorrowLtvWithdrawLimit({
      liquidity: makeLiquidity({ liability: 4_000n * WAD, collaterals: [{ address: COLLATERAL, borrowing: 8_000n * WAD }] }),
      collateralAddress: COLLATERAL.toLowerCase(),
      collateralAssets: 100n * WAD,
    })).toBe(49_500n * 10n ** 15n)
  })
})

describe('isAtBorrowLtvLimit', () => {
  it('returns undefined when liquidity is unavailable', () => {
    expect(isAtBorrowLtvLimit(undefined)).toBeUndefined()
  })

  it('is false without a liability', () => {
    expect(isAtBorrowLtvLimit(makeLiquidity({ liability: 0n, collaterals: [] }))).toBe(false)
  })

  it('is false while the borrow-adjusted collateral value exceeds the liability', () => {
    expect(isAtBorrowLtvLimit(makeLiquidity({
      liability: 4_000n * WAD,
      collaterals: [{ address: COLLATERAL, borrowing: 8_000n * WAD }],
    }))).toBe(false)
  })

  it('is true when the borrow-adjusted collateral value equals the liability', () => {
    expect(isAtBorrowLtvLimit(makeLiquidity({
      liability: 8_000n * WAD,
      collaterals: [{ address: COLLATERAL, borrowing: 8_000n * WAD }],
    }))).toBe(true)
  })

  it('is true when the only collateral has a borrow LTV of 0', () => {
    expect(isAtBorrowLtvLimit(zeroBorrowLtvLiquidity)).toBe(true)
  })
})

describe('getBorrowLtvWithdrawNotice', () => {
  it('returns null when liquidity is unavailable', () => {
    expect(getBorrowLtvWithdrawNotice({
      liquidity: undefined,
      collateralAddress: COLLATERAL,
      collateralBorrowLTV: 0,
      symbol: 'wstHYPE',
    })).toBeNull()
  })

  it('returns null while some collateral can still be withdrawn', () => {
    expect(getBorrowLtvWithdrawNotice({
      liquidity: makeLiquidity({ liability: 4_000n * WAD, collaterals: [{ address: COLLATERAL, borrowing: 8_000n * WAD }] }),
      collateralAddress: COLLATERAL,
      collateralBorrowLTV: 0.8,
      symbol: 'WETH',
    })).toBeNull()
  })

  it('returns null inside the Max margin, where the position is still under its borrow limit', () => {
    expect(getBorrowLtvWithdrawNotice({
      liquidity: makeLiquidity({ liability: 4_000n * WAD, collaterals: [{ address: COLLATERAL, borrowing: 4_020n * WAD }] }),
      collateralAddress: COLLATERAL,
      collateralBorrowLTV: 0.8,
      symbol: 'WETH',
    })).toBeNull()
  })

  it('asks for a full repay when the only collateral has a borrow LTV of 0', () => {
    expect(getBorrowLtvWithdrawNotice({
      liquidity: zeroBorrowLtvLiquidity,
      collateralAddress: COLLATERAL,
      collateralBorrowLTV: 0,
      symbol: 'wstHYPE',
    })).toEqual({
      level: 'high',
      title: 'Borrow LTV is 0',
      message: 'wstHYPE has a borrow LTV of 0 in this market, so it no longer counts toward your borrow limit. Repay the full debt to withdraw it.',
    })
  })

  it('points at other collateral when a zero borrow LTV collateral sits next to collateral that cannot cover the debt', () => {
    expect(getBorrowLtvWithdrawNotice({
      liquidity: makeLiquidity({
        liability: 1_000n * WAD,
        collaterals: [
          { address: COLLATERAL, borrowing: 0n },
          { address: OTHER_COLLATERAL, borrowing: 900n * WAD },
        ],
      }),
      collateralAddress: COLLATERAL,
      collateralBorrowLTV: 0,
      symbol: 'wstHYPE',
    })?.message).toBe('wstHYPE has a borrow LTV of 0 in this market, so it no longer counts toward your borrow limit. Repay debt or add a different collateral to withdraw it.')
  })

  it('explains the borrow limit when the position has no headroom left', () => {
    expect(getBorrowLtvWithdrawNotice({
      liquidity: makeLiquidity({ liability: 8_000n * WAD, collaterals: [{ address: COLLATERAL, borrowing: 8_000n * WAD }] }),
      collateralAddress: COLLATERAL,
      collateralBorrowLTV: 0.8,
      symbol: 'WETH',
    })).toEqual({
      level: 'high',
      title: 'LTV limit reached',
      message: 'Your position is at its borrow LTV limit, so no collateral can be withdrawn. Repay debt or supply more collateral first.',
    })
  })
})

describe('getCashLimitedWithdrawAmount', () => {
  const eVault = (availableLiquidity: bigint) => ({ type: 'EVault', availableLiquidity } as EVault)
  const securitizeVault = (totalAssets: bigint) =>
    ({ type: 'SecuritizeCollateral', totalAssets } as SecuritizeCollateralVault)
  const earnVault = (availableAssets: bigint) =>
    ({ type: 'EulerEarn', availableAssets } as EulerEarn)

  it('returns the user withdrawable amount when EVault liquidity is higher', () => {
    expect(getCashLimitedWithdrawAmount(1_000n, eVault(2_000n))).toBe(1_000n)
  })

  it('caps the amount to EVault available liquidity when liquidity is lower', () => {
    expect(getCashLimitedWithdrawAmount(2_000n, eVault(1_000n))).toBe(1_000n)
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
})
