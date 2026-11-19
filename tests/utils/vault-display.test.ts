import { describe, expect, it } from 'vitest'

import { formatMarketAvailability, formatVaultBorrowAvailability, getVaultSupplyApy, getVaultTotalSupplyApy } from '~/utils/vault-display'
import { NO_OPERATIONS_HOOKED, makeEusdc42 } from '~/tests/fixtures/liquity-hub'

describe('getVaultSupplyApy', () => {
  it('reads EVault interest rate supply APY', () => {
    expect(getVaultSupplyApy({ interestRates: { supplyAPY: 4.2 } })).toBe(4.2)
  })

  it('reads Earn supplyApy', () => {
    expect(getVaultSupplyApy({ supplyApy: 3.1 })).toBe(3.1)
  })

  it('returns zero when Earn supply APY is missing', () => {
    expect(getVaultSupplyApy({ totalAssets: 100n })).toBe(0)
  })
})

describe('getVaultTotalSupplyApy', () => {
  it('preserves intrinsic and reward APY for a non-interest Securitize vault', () => {
    const vault = {
      type: 'SecuritizeCollateral',
      totalAssets: 100n,
      intrinsicApy: { apy: 2, provider: 'test' },
    }

    expect(getVaultTotalSupplyApy(vault, true, 5)).toBe(7)
  })
})

describe('formatMarketAvailability', () => {
  it('formats unavailable, singular, and plural market counts', () => {
    expect(formatMarketAvailability(0)).toBe('No')
    expect(formatMarketAvailability(1)).toBe('Yes in 1 market')
    expect(formatMarketAvailability(2)).toBe('Yes in 2 markets')
  })
})

describe('formatVaultBorrowAvailability', () => {
  it('reads Paused for a vault with borrow hooked, whatever its LTVs', () => {
    expect(formatVaultBorrowAvailability(makeEusdc42())).toEqual({ canBorrow: false, label: 'Paused' })
  })

  it('keeps "No" for a paused vault that lends to no market', () => {
    const noMarkets = Object.assign(makeEusdc42(), { collaterals: [] })
    expect(formatVaultBorrowAvailability(noMarkets)).toEqual({ canBorrow: false, label: 'No' })
  })

  it('counts the markets a live vault lends to', () => {
    expect(formatVaultBorrowAvailability(makeEusdc42({ hookedOperations: NO_OPERATIONS_HOOKED })))
      .toEqual({ canBorrow: true, label: 'Yes in 4 markets' })
  })
})
