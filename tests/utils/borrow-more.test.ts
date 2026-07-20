import { describe, expect, it } from 'vitest'
import {
  formatBorrowMoreInputAmount,
  getBorrowMoreAvailableLiquidityDisplay,
  getBorrowMoreLtvHeadroomAmount,
  getBorrowMoreMaxBorrowAmount,
  getBorrowMorePositionLtv,
  getBorrowMoreProjectedLtv,
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
