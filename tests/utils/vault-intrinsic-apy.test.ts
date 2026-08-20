/**
 * Spec for the vault-entity-based intrinsic APY helpers.
 *
 * Replaces the address-keyed lookup pattern in composables/useIntrinsicApy.ts.
 * Old call sites looked like:
 *
 *   const { withIntrinsicSupplyApy } = useIntrinsicApy()
 *   const apy = withIntrinsicSupplyApy(base, vault.asset.address)
 *
 * New call sites (post-migration) look like:
 *
 *   const apy = withVaultIntrinsicApy(base, vault, enableFlag)
 *
 * Data source is the SDK-populated `vault.intrinsicApy` field (set by
 * `intrinsicApyService.populateIntrinsicApy`), not an app-owned
 * address-keyed cache. Helpers are pure.
 *
 * Formula matches existing applyIntrinsicApy:
 *   result = base + (1 + base / 100) * intrinsic
 *
 * Written before the helpers exist; fails at import until
 * `~/utils/vault-intrinsic-apy` is added.
 */
import { describe, expect, it } from 'vitest'
import type { IntrinsicApyInfo } from '@eulerxyz/euler-v2-sdk'
import {
  combineApyWithIntrinsic,
  EMPTY_INTRINSIC_APY,
  getVaultIntrinsicApy,
  getVaultIntrinsicApyInfo,
  resolveVaultIntrinsicApySource,
  withProjectedVaultIntrinsicApy,
  withVaultIntrinsicApy,
} from '~/utils/vault-intrinsic-apy'

const apyInfo = (apy: number, provider = 'defillama', source?: string): IntrinsicApyInfo => ({
  apy,
  provider,
  ...(source ? { source } : {}),
})

// Minimal vault stand-in. The helpers only read `intrinsicApy`, so we don't
// need the full vault shape — just enough to type-check against an
// SDK-shaped object.
const vaultWith = (intrinsicApy: IntrinsicApyInfo | undefined) => ({
  intrinsicApy,
  // The address is read by no helper but appears in fixtures for realism.
  asset: { address: '0x1111111111111111111111111111111111111111' as const },
})

describe('resolveVaultIntrinsicApySource', () => {
  it('falls back to a populated Securitize vault when EVault sources are unavailable', () => {
    const securitizeVault = vaultWith(apyInfo(2.632044, 'SECURITIZE'))

    const resolved = resolveVaultIntrinsicApySource(undefined, undefined, securitizeVault)

    expect(resolved).toBe(securitizeVault)
    expect(getVaultIntrinsicApyInfo(resolved, true)).toEqual(apyInfo(2.632044, 'SECURITIZE'))
  })

  it('keeps the projected EVault ahead of the base and Securitize fallbacks', () => {
    const projectedVault = vaultWith(apyInfo(3, 'projected'))
    const baseVault = vaultWith(apyInfo(2, 'base'))
    const securitizeVault = vaultWith(apyInfo(1, 'SECURITIZE'))

    expect(resolveVaultIntrinsicApySource(projectedVault, baseVault, securitizeVault))
      .toBe(projectedVault)
  })
})

describe('getVaultIntrinsicApyInfo', () => {
  it('returns the populated info on the vault', () => {
    const v = vaultWith(apyInfo(4.5, 'pendle', 'pt-eUSDe'))
    expect(getVaultIntrinsicApyInfo(v, true)).toEqual(apyInfo(4.5, 'pendle', 'pt-eUSDe'))
  })

  it('returns EMPTY_INTRINSIC_APY when the vault has no intrinsicApy populated', () => {
    const v = vaultWith(undefined)
    expect(getVaultIntrinsicApyInfo(v, true)).toEqual(EMPTY_INTRINSIC_APY)
  })

  it('returns EMPTY_INTRINSIC_APY when the feature is disabled, regardless of vault data', () => {
    const v = vaultWith(apyInfo(4.5))
    expect(getVaultIntrinsicApyInfo(v, false)).toEqual(EMPTY_INTRINSIC_APY)
  })

  it('returns EMPTY_INTRINSIC_APY for an undefined vault', () => {
    expect(getVaultIntrinsicApyInfo(undefined, true)).toEqual(EMPTY_INTRINSIC_APY)
  })

  it('EMPTY_INTRINSIC_APY has apy=0 and a stable string provider', () => {
    expect(EMPTY_INTRINSIC_APY.apy).toBe(0)
    expect(typeof EMPTY_INTRINSIC_APY.provider).toBe('string')
  })
})

describe('getVaultIntrinsicApy', () => {
  it('returns the numeric apy when populated and enabled', () => {
    expect(getVaultIntrinsicApy(vaultWith(apyInfo(3.2)), true)).toBe(3.2)
  })

  it('returns 0 when disabled', () => {
    expect(getVaultIntrinsicApy(vaultWith(apyInfo(3.2)), false)).toBe(0)
  })

  it('returns 0 when the vault carries no intrinsic apy', () => {
    expect(getVaultIntrinsicApy(vaultWith(undefined), true)).toBe(0)
  })

  it('returns 0 for an undefined vault', () => {
    expect(getVaultIntrinsicApy(undefined, true)).toBe(0)
  })
})

describe('combineApyWithIntrinsic', () => {
  it('pins the compounded total used by Earn/Supply displays and APY modals', () => {
    const base = 4
    const intrinsic = 1
    const rewards = 0.5

    const compounded = combineApyWithIntrinsic(base, intrinsic)

    expect(compounded).toBeCloseTo(4 + (1 + 4 / 100) * 1)
    expect(compounded + rewards).toBeCloseTo(5.54)
    expect(base + intrinsic + rewards).toBe(5.5)
  })

  it('pins borrow-side totals as compounded intrinsic minus rewards', () => {
    const borrowing = 6
    const intrinsic = 2
    const rewards = 0.25

    expect(combineApyWithIntrinsic(borrowing, intrinsic) - rewards)
      .toBeCloseTo(6 + (1 + 6 / 100) * 2 - 0.25)
  })
})

describe('withVaultIntrinsicApy', () => {
  // Compounding formula must match existing applyIntrinsicApy:
  //   result = base + (1 + base / 100) * intrinsic
  it('compounds the intrinsic APY onto the base APY (canonical formula)', () => {
    const out = withVaultIntrinsicApy(5, vaultWith(apyInfo(2)), true)
    expect(out).toBeCloseTo(5 + (1 + 5 / 100) * 2)
  })

  it('returns base unchanged when the feature is disabled', () => {
    expect(withVaultIntrinsicApy(5, vaultWith(apyInfo(2)), false)).toBe(5)
  })

  it('returns base unchanged when the vault has no intrinsic apy', () => {
    expect(withVaultIntrinsicApy(5, vaultWith(undefined), true)).toBe(5)
  })

  it('returns base unchanged for an undefined vault', () => {
    expect(withVaultIntrinsicApy(5, undefined, true)).toBe(5)
  })

  it('handles base = 0 (no compounding on top of nothing)', () => {
    expect(withVaultIntrinsicApy(0, vaultWith(apyInfo(3)), true)).toBeCloseTo(3)
  })

  it('handles intrinsic = 0 (returns base unchanged)', () => {
    expect(withVaultIntrinsicApy(5, vaultWith(apyInfo(0)), true)).toBe(5)
  })

  it('is the same formula for supply and borrow (single helper, no role split)', () => {
    // The old code aliased withIntrinsicSupplyApy = withIntrinsicBorrowApy
    // because the formula is symmetric. The new helper preserves that —
    // role semantics live at the call site, not in the formula.
    const supply = withVaultIntrinsicApy(5, vaultWith(apyInfo(2)), true)
    const borrow = withVaultIntrinsicApy(5, vaultWith(apyInfo(2)), true)
    expect(supply).toBe(borrow)
  })
})

describe('withProjectedVaultIntrinsicApy', () => {
  it('recomputes compounding from the projected raw APY', () => {
    const vault = vaultWith(apyInfo(4))

    expect(withProjectedVaultIntrinsicApy(5, 8, vault, true))
      .toBeCloseTo(8 + (1 + 8 / 100) * 4)
  })

  it('falls back to the current raw APY when projection is unavailable', () => {
    const vault = vaultWith(apyInfo(4))

    expect(withProjectedVaultIntrinsicApy(5, null, vault, true))
      .toBe(withVaultIntrinsicApy(5, vault, true))
  })
})

describe('helpers are pure — no module-level state', () => {
  it('repeated calls with the same inputs produce identical outputs', () => {
    const v = vaultWith(apyInfo(4))
    const a = withVaultIntrinsicApy(7, v, true)
    const b = withVaultIntrinsicApy(7, v, true)
    expect(a).toBe(b)
  })

  it('mutating the vault.intrinsicApy reference is reflected in subsequent reads', () => {
    const v: ReturnType<typeof vaultWith> = vaultWith(apyInfo(1))
    expect(getVaultIntrinsicApy(v, true)).toBe(1)
    v.intrinsicApy = apyInfo(2)
    expect(getVaultIntrinsicApy(v, true)).toBe(2)
  })
})
