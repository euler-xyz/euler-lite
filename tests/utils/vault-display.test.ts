import { describe, expect, it } from 'vitest'

import { formatMarketAvailability, getVaultSupplyApy } from '~/utils/vault-display'

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

describe('formatMarketAvailability', () => {
  it('formats unavailable, singular, and plural market counts', () => {
    expect(formatMarketAvailability(0)).toBe('No')
    expect(formatMarketAvailability(1)).toBe('Yes in 1 market')
    expect(formatMarketAvailability(2)).toBe('Yes in 2 markets')
  })
})
