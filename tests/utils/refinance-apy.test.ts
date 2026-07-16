import { describe, expect, it, vi } from 'vitest'
import { buildRefinanceProjectedRateRequests, getRefinanceRewardCollateralAddresses, getSameAssetRefinanceBorrowAmount, resolveRefinanceCollateralLegs } from '~/utils/refinance-apy'

const source = {
  address: '0x0000000000000000000000000000000000000001',
  totalCash: 1_000n,
  totalBorrowed: 500n,
}
const target = {
  address: '0x0000000000000000000000000000000000000002',
  totalCash: 2_000n,
  totalBorrowed: 800n,
}

describe('buildRefinanceProjectedRateRequests', () => {
  it('projects source withdrawal, target deposit, and target debt together', () => {
    expect(buildRefinanceProjectedRateRequests(
      [
        { vault: source, cashDelta: -100n },
        { vault: target, cashDelta: 95n },
      ],
      [{ vault: target, borrowsDelta: 50n }],
    )).toEqual([
      {
        address: source.address,
        request: {
          vaultAddress: source.address,
          currentCash: 1_000n,
          currentBorrows: 500n,
          cashDelta: -100n,
          borrowsDelta: 0n,
        },
      },
      {
        address: target.address,
        request: {
          vaultAddress: target.address,
          currentCash: 2_000n,
          currentBorrows: 800n,
          cashDelta: 45n,
          borrowsDelta: 50n,
        },
      },
    ])
  })

  it('merges source debt repayment when the source debt vault becomes collateral', () => {
    expect(buildRefinanceProjectedRateRequests(
      [{ vault: source, cashDelta: 95n }],
      [
        { vault: target, borrowsDelta: 50n },
        { vault: source, borrowsDelta: -100n },
      ],
    )).toEqual([
      {
        address: source.address,
        request: {
          vaultAddress: source.address,
          currentCash: 1_000n,
          currentBorrows: 500n,
          cashDelta: 195n,
          borrowsDelta: -100n,
        },
      },
      {
        address: target.address,
        request: {
          vaultAddress: target.address,
          currentCash: 2_000n,
          currentBorrows: 800n,
          cashDelta: -50n,
          borrowsDelta: 50n,
        },
      },
    ])
  })

  it('drops zero-net collateral moves', () => {
    expect(buildRefinanceProjectedRateRequests([
      { vault: target, cashDelta: -100n },
      { vault: target, cashDelta: 100n },
    ])).toEqual([])
  })
})

describe('getSameAssetRefinanceBorrowAmount', () => {
  it('matches the SDK interest cushion for an internal Euler refinance', () => {
    expect(getSameAssetRefinanceBorrowAmount(1_000_000n, false)).toBe(1_000_100n)
  })

  it('matches the explicit one-percent borrow buffer for an external migration', () => {
    expect(getSameAssetRefinanceBorrowAmount(1_000_000n, true)).toBe(1_010_000n)
  })
})

describe('getRefinanceRewardCollateralAddresses', () => {
  it('retains sibling collateral addresses when replacing the selected source', () => {
    const sibling = '0x0000000000000000000000000000000000000003'

    expect(getRefinanceRewardCollateralAddresses([
      { vaultAddress: source.address, assets: 100n },
      { vaultAddress: sibling, assets: 50n },
    ], source.address, target.address)).toEqual([
      sibling,
      target.address,
    ])
  })
})

describe('resolveRefinanceCollateralLegs', () => {
  it('resolves an unenriched position before validating the vault shape', () => {
    const registryVault = {
      ...source,
      asset: { address: source.address },
      shares: { decimals: 18 },
    }
    const resolveVault = vi.fn(() => registryVault)

    expect(resolveRefinanceCollateralLegs(
      [{ vaultAddress: source.address, assets: 100n }],
      resolveVault,
      (vault): vault is typeof registryVault => !!vault && 'asset' in vault && 'shares' in vault,
    )).toEqual([{ vault: registryVault, amount: 100n }])
    expect(resolveVault).toHaveBeenCalledWith(source.address, undefined)
  })
})
