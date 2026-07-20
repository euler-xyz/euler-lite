import { describe, expect, it } from 'vitest'
import {
  formatBorrowMoreInputAmount,
  getBorrowMoreAvailableLiquidityDisplay,
  getBorrowMoreDraftReconciliation,
  getBorrowMoreLtvHeadroomAmount,
  getBorrowMoreMaxBorrowAmount,
  getBorrowMorePositionIdentityKey,
  getBorrowMorePositionLtv,
  getBorrowMoreProjectedLtv,
  reconcileBorrowMoreDraftBeforeYieldRefresh,
} from '~/utils/borrow-more'

const usdc = {
  asset: {
    decimals: 6,
    symbol: 'USDC',
  },
}

describe('borrow-more position risk', () => {
  it('uses the user LTV when it is available', () => {
    expect(getBorrowMorePositionLtv({
      userLTV: 40n,
      currentLTV: 30n,
    })).toBe(40n)
  })

  it('falls back to the current LTV', () => {
    expect(getBorrowMorePositionLtv({ currentLTV: 30n })).toBe(30n)
  })

  it('stays unavailable when oracle-derived risk is missing', () => {
    expect(getBorrowMorePositionLtv({})).toBeUndefined()
  })

  it('recomputes a retained manual amount from the refreshed position baseline', () => {
    const input = {
      borrowDecimals: 6,
      additionalBorrowAmount: '20',
      totalCollateral: 400,
    }

    expect(getBorrowMoreProjectedLtv({ ...input, borrowed: 100_000_000n })).toBe(30)
    expect(getBorrowMoreProjectedLtv({ ...input, borrowed: 160_000_000n })).toBe(45)
  })

  it('does not project risk without collateral value', () => {
    expect(getBorrowMoreProjectedLtv({
      borrowed: 100_000_000n,
      borrowDecimals: 6,
      additionalBorrowAmount: '20',
      totalCollateral: 0,
    })).toBeUndefined()
  })

  it('scopes retained input to the same chain, account, sub-account, and vault pair', () => {
    const positionA = {
      chainId: 56,
      account: '0xAccountA',
      subAccount: '0xSubAccountA',
      collateralVaultAddress: '0xCollateral',
      borrowVaultAddress: '0xBorrow',
    }
    const keyA = getBorrowMorePositionIdentityKey(positionA)

    expect(getBorrowMorePositionIdentityKey({ ...positionA, account: '0xaccounta' })).toBe(keyA)
    expect(getBorrowMorePositionIdentityKey({ ...positionA, chainId: 1 })).not.toBe(keyA)
    expect(getBorrowMorePositionIdentityKey({ ...positionA, account: '0xAccountB' })).not.toBe(keyA)
    expect(getBorrowMorePositionIdentityKey({ ...positionA, subAccount: '0xSubAccountB' })).not.toBe(keyA)
    expect(getBorrowMorePositionIdentityKey({ ...positionA, collateralVaultAddress: '0xCollateralB' })).not.toBe(keyA)
    expect(getBorrowMorePositionIdentityKey({ ...positionA, borrowVaultAddress: '0xBorrowB' })).not.toBe(keyA)
  })

  it('reconciles an A draft to B before optional yield enrichment can fail', async () => {
    const nextDraft = getBorrowMoreDraftReconciliation({
      loadedPositionIdentityKey: 'chain:account-a:sub-account:vault-a:debt-a',
      nextPositionIdentityKey: 'chain:account-b:sub-account:vault-b:debt-b',
      isLtvDriven: false,
      borrowAmount: '20',
      borrowed: 100_000_000n,
      borrowDecimals: 6,
      totalCollateral: 400,
      baselineLtv: 25,
    })

    let visibleDraft: ReturnType<typeof getBorrowMoreDraftReconciliation> | undefined
    let yieldError: unknown
    await reconcileBorrowMoreDraftBeforeYieldRefresh({
      draft: nextDraft,
      commitDraft: (draft) => { visibleDraft = draft },
      refreshYield: () => Promise.reject(new Error('yield unavailable')),
      onYieldError: (error) => { yieldError = error },
    })

    expect(visibleDraft).toEqual({
      borrowAmount: '',
      isLtvDriven: true,
      ltv: 25,
      retained: false,
    })
    expect(yieldError).toEqual(new Error('yield unavailable'))
  })
})

describe('borrow-more liquidity display', () => {
  it('formats available liquidity for the selected borrow vault', () => {
    expect(getBorrowMoreAvailableLiquidityDisplay({
      ...usdc,
      availableLiquidity: 123_450_000n,
    })).toEqual({
      exact: '123.45 USDC',
      display: '123.45 USDC',
    })
  })

  it('returns null for unknown liquidity so the UI can render an explicit fallback', () => {
    expect(getBorrowMoreAvailableLiquidityDisplay(usdc)).toBeNull()
    expect(getBorrowMoreAvailableLiquidityDisplay(undefined)).toBeNull()
  })
})

describe('borrow-more max borrow amount', () => {
  const riskHeadroom = getBorrowMoreLtvHeadroomAmount({
    borrowed: 100_000_000n,
    borrowDecimals: 6,
    assetDecimals: 6,
    currentLtvPercent: 50,
    maxBorrowLtv: 7500n,
  })

  it('computes a positive LTV headroom amount for the max action', () => {
    expect(riskHeadroom).toBe(49_980_000n)
    expect(formatBorrowMoreInputAmount(riskHeadroom, 6)).toBe('49.98')
  })

  it('caps Max by available liquidity when liquidity is lower than risk headroom', () => {
    const maxBorrow = getBorrowMoreMaxBorrowAmount({
      availableLiquidity: 20_000_000n,
      ltvHeadroom: riskHeadroom,
    })

    expect(maxBorrow).toBe(20_000_000n)
    expect(formatBorrowMoreInputAmount(maxBorrow!, 6)).toBe('20')
  })

  it('caps Max by position risk headroom when liquidity is higher', () => {
    const maxBorrow = getBorrowMoreMaxBorrowAmount({
      availableLiquidity: 1_000_000_000n,
      ltvHeadroom: riskHeadroom,
    })

    expect(maxBorrow).toBe(riskHeadroom)
    expect(formatBorrowMoreInputAmount(maxBorrow!, 6)).toBe('49.98')
  })

  it('stays unavailable until both liquidity and position risk are known', () => {
    expect(getBorrowMoreMaxBorrowAmount({
      availableLiquidity: undefined,
      ltvHeadroom: riskHeadroom,
    })).toBeUndefined()
    expect(getBorrowMoreMaxBorrowAmount({
      availableLiquidity: 20_000_000n,
      ltvHeadroom: undefined,
    })).toBeUndefined()
  })
})
