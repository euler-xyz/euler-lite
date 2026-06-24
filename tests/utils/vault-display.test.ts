import { describe, expect, it } from 'vitest'

import { formatMarketAvailability, getVaultUtilizationDelta, getVaultUtilizationDeltaActionLabel } from '~/utils/vault-display'

describe('formatMarketAvailability', () => {
  it('formats unavailable, singular, and plural market counts', () => {
    expect(formatMarketAvailability(0)).toBe('No')
    expect(formatMarketAvailability(1)).toBe('Yes in 1 market')
    expect(formatMarketAvailability(2)).toBe('Yes in 2 markets')
  })
})

describe('getVaultUtilizationDelta', () => {
  const vault = {
    totalAssets: 1000n,
    totalBorrowed: 160n,
  }

  it('returns the borrow amount needed to reach a higher utilization target', () => {
    expect(getVaultUtilizationDelta(vault, 90)).toEqual({
      amount: 740n,
      direction: 'borrow',
    })
  })

  it('returns the repay amount needed to reach a lower utilization target', () => {
    expect(getVaultUtilizationDelta(vault, 10)).toEqual({
      amount: 60n,
      direction: 'repay',
    })
  })

  it('returns none when the target matches current utilization', () => {
    expect(getVaultUtilizationDelta(vault, 16)).toEqual({
      amount: 0n,
      direction: 'none',
    })
  })

  it('clamps targets to the valid utilization range', () => {
    expect(getVaultUtilizationDelta(vault, 120)).toEqual({
      amount: 840n,
      direction: 'borrow',
    })
    expect(getVaultUtilizationDelta(vault, -10)).toEqual({
      amount: 160n,
      direction: 'repay',
    })
  })
})

describe('getVaultUtilizationDeltaActionLabel', () => {
  it('labels higher target utilization as borrow', () => {
    expect(getVaultUtilizationDeltaActionLabel({
      amount: 740n,
      direction: 'borrow',
    })).toBe('Borrow')
  })

  it('labels lower target utilization as repay', () => {
    expect(getVaultUtilizationDeltaActionLabel({
      amount: 60n,
      direction: 'repay',
    })).toBe('Repay')
  })

  it('labels matching target utilization as no change', () => {
    expect(getVaultUtilizationDeltaActionLabel({
      amount: 0n,
      direction: 'none',
    })).toBe('No change')
  })
})
