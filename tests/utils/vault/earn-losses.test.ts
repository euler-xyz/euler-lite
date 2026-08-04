import { describe, it, expect } from 'vitest'
import { computeUncoveredLosses, EARN_LOSS_COVERAGE_ADDRESS } from '~/utils/vault/earn-losses'

// Mirrors EulerEarn's VIRTUAL_AMOUNT conversion so the fixtures behave like the
// real entity rather than a 1:1 share price.
const VIRTUAL_AMOUNT = 1_000_000n

const makeVault = (lostAssets: bigint, totalAssets = 1_000n * 10n ** 18n, totalShares = 1_000n * 10n ** 18n) => ({
  lostAssets,
  convertToAssets: (shares: bigint) =>
    (shares * (totalAssets + VIRTUAL_AMOUNT)) / (totalShares + VIRTUAL_AMOUNT),
})

describe('computeUncoveredLosses', () => {
  it('is zero when the vault never recorded a shortfall', () => {
    expect(computeUncoveredLosses(makeVault(0n), 0n)).toBe(0n)
    expect(computeUncoveredLosses(makeVault(0n), 500n * 10n ** 18n)).toBe(0n)
  })

  it('reports the full shortfall when nothing is parked at the coverage address', () => {
    const vault = makeVault(10n * 10n ** 18n)
    expect(computeUncoveredLosses(vault, 0n)).toBe(10n * 10n ** 18n)
  })

  it('subtracts the asset value of the coverage shares', () => {
    const vault = makeVault(10n * 10n ** 18n)
    const coverageShares = 4n * 10n ** 18n
    const expected = 10n * 10n ** 18n - vault.convertToAssets(coverageShares)

    expect(computeUncoveredLosses(vault, coverageShares)).toBe(expected)
  })

  it('clamps to zero when coverage exceeds the shortfall', () => {
    const vault = makeVault(10n * 10n ** 18n)
    expect(computeUncoveredLosses(vault, 50n * 10n ** 18n)).toBe(0n)
  })

  it('converts coverage shares at the vault share price, not 1:1', () => {
    // Share price above par: 2 assets per share, so 3 shares cover 6 assets.
    const vault = makeVault(10n * 10n ** 18n, 2_000n * 10n ** 18n, 1_000n * 10n ** 18n)
    const uncovered = computeUncoveredLosses(vault, 3n * 10n ** 18n)

    expect(uncovered).toBeLessThan(10n * 10n ** 18n - 3n * 10n ** 18n)
    expect(uncovered).toBe(10n * 10n ** 18n - vault.convertToAssets(3n * 10n ** 18n))
  })

  it('treats an unresolved coverage read as no coverage', () => {
    const vault = makeVault(10n * 10n ** 18n)
    expect(computeUncoveredLosses(vault, undefined)).toBe(10n * 10n ** 18n)
  })

  it('pins the canonical coverage sink to address(1)', () => {
    expect(EARN_LOSS_COVERAGE_ADDRESS).toBe('0x0000000000000000000000000000000000000001')
  })

  // Live mainnet state for TelosC Surge USDC (0x49C5733d71511A78a3E12925ea832f49031c97e9),
  // a real fully covered loss: the shares parked at address(1) are worth more
  // than the recorded shortfall, so nothing is left unbacked.
  it('reports zero for a real fully covered vault', () => {
    const vault = {
      lostAssets: 238869503n,
      convertToAssets: (shares: bigint) => (shares === 238870000n ? 244068111n : 0n),
    }

    expect(computeUncoveredLosses(vault, 238870000n)).toBe(0n)
  })
})
