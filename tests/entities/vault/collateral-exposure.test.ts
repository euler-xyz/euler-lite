import { describe, it, expect } from 'vitest'
import {
  getCollateralExposurePairs,
  hasCollateralExposure,
  type CollateralVaultResolver,
} from '~/entities/vault/collateral-exposure'
import type { Vault, SecuritizeVault, VaultCollateralLTV } from '~/entities/vault/types'

// Time anchors used across tests. All ramp configs below are expressed relative
// to these so the ramp maths are easy to reason about.
const NOW = 1500n
const BEFORE_RAMP = 500n
const RAMP_COMPLETE = 3000n

/**
 * Build a VaultCollateralLTV with reasonable defaults. By default the
 * liquidation LTV has fully ramped down to 0 — tests opt in to live config by
 * overriding the fields they care about.
 */
const makeLtv = (overrides: Partial<VaultCollateralLTV> = {}): VaultCollateralLTV => ({
  collateral: '0xcoll0000000000000000000000000000000000000',
  borrowLTV: 0n,
  liquidationLTV: 0n,
  initialLiquidationLTV: 0n,
  rampDuration: 1000n,
  targetTimestamp: 2000n,
  ...overrides,
})

/**
 * Minimal collateral vault for assertion; the predicate only reads
 * `totalAssets`, but we stamp an address so callers can distinguish pairs in
 * the returned array.
 */
const makeCollateral = (
  address: string,
  totalAssets: bigint,
): Vault | SecuritizeVault =>
  ({ address, totalAssets } as unknown as Vault)

/**
 * Build a resolver that returns the collateral at a given address, or
 * undefined if it wasn't registered. This matches the contract of the real
 * `useVaultRegistry().get(addr)?.vault` lookup.
 */
const makeResolver = (
  entries: Record<string, Vault | SecuritizeVault>,
): CollateralVaultResolver => addr => entries[addr]

const borrowableLtv = (collateralAddress: string): VaultCollateralLTV =>
  makeLtv({
    collateral: collateralAddress,
    borrowLTV: 7500n,
    liquidationLTV: 8000n,
    initialLiquidationLTV: 8000n,
    targetTimestamp: 2000n, // already at target → not ramping, current = 8000n
  })

const rampingDownLtv = (collateralAddress: string): VaultCollateralLTV =>
  makeLtv({
    collateral: collateralAddress,
    borrowLTV: 0n, // no new borrows allowed
    liquidationLTV: 7000n, // target
    initialLiquidationLTV: 9000n, // started higher → ramping DOWN
    targetTimestamp: 2000n,
    rampDuration: 1000n,
  })

const fullyRampedDownLtv = (collateralAddress: string): VaultCollateralLTV =>
  makeLtv({
    collateral: collateralAddress,
    borrowLTV: 0n,
    liquidationLTV: 0n,
    initialLiquidationLTV: 9000n,
    targetTimestamp: 2000n, // now >= target → current = liquidationLTV = 0n
  })

describe('getCollateralExposurePairs', () => {
  it('returns pairs that are currently borrowable', () => {
    const vault = { collateralLTVs: [borrowableLtv('0xaaa')] }
    const resolver = makeResolver({ '0xaaa': makeCollateral('0xaaa', 1_000n) })
    const pairs = getCollateralExposurePairs(vault, resolver, NOW)

    expect(pairs).toHaveLength(1)
    expect(pairs[0].collateral.address).toBe('0xaaa')
    expect(pairs[0].borrowLTV).toBe(7500n)
  })

  it('includes pairs where borrowLTV is 0 but the collateral has outstanding supply during ramp-down', () => {
    const vault = { collateralLTVs: [rampingDownLtv('0xaaa')] }
    const resolver = makeResolver({ '0xaaa': makeCollateral('0xaaa', 1_000n) })
    const pairs = getCollateralExposurePairs(vault, resolver, NOW)

    // borrowLTV == 0 but collateral has supply → open interest can still
    // accrue while liquidation LTV ramps down, so the pair must be kept.
    expect(pairs).toHaveLength(1)
    expect(pairs[0].borrowLTV).toBe(0n)
  })

  it('excludes pairs that have fully ramped down', () => {
    const vault = { collateralLTVs: [fullyRampedDownLtv('0xaaa')] }
    const resolver = makeResolver({ '0xaaa': makeCollateral('0xaaa', 1_000n) })
    // After targetTimestamp, liquidationLTV settles at the target value (0 here).
    const pairs = getCollateralExposurePairs(vault, resolver, RAMP_COMPLETE)

    // currentLiquidationLTV == 0 → no exposure regardless of supply.
    expect(pairs).toHaveLength(0)
  })

  it('keeps a pair mid ramp-down with outstanding supply even when the target LTV is 0', () => {
    const vault = { collateralLTVs: [fullyRampedDownLtv('0xaaa')] }
    const resolver = makeResolver({ '0xaaa': makeCollateral('0xaaa', 1_000n) })
    // At NOW=1500 the ramp is only half-done: current LTV ≈ 4500, so the
    // pair is still live and existing borrows can still accrue interest.
    const pairs = getCollateralExposurePairs(vault, resolver, NOW)

    expect(pairs).toHaveLength(1)
  })

  it('excludes pairs with borrowLTV 0 and no collateral supply', () => {
    const vault = { collateralLTVs: [rampingDownLtv('0xaaa')] }
    const resolver = makeResolver({ '0xaaa': makeCollateral('0xaaa', 0n) })
    const pairs = getCollateralExposurePairs(vault, resolver, NOW)

    // Not borrowable now, and no open interest possible without supply.
    expect(pairs).toHaveLength(0)
  })

  it('skips pairs whose collateral is not in the registry', () => {
    const vault = {
      collateralLTVs: [borrowableLtv('0xaaa'), borrowableLtv('0xbbb')],
    }
    const resolver = makeResolver({ '0xaaa': makeCollateral('0xaaa', 1_000n) })
    const pairs = getCollateralExposurePairs(vault, resolver, NOW)

    expect(pairs).toHaveLength(1)
    expect(pairs[0].collateral.address).toBe('0xaaa')
  })

  it('sorts pairs by borrowLTV descending', () => {
    const vault = {
      collateralLTVs: [
        makeLtv({ collateral: '0xlow', borrowLTV: 5000n, liquidationLTV: 6000n, initialLiquidationLTV: 6000n }),
        makeLtv({ collateral: '0xhigh', borrowLTV: 8500n, liquidationLTV: 9000n, initialLiquidationLTV: 9000n }),
        makeLtv({ collateral: '0xmid', borrowLTV: 7000n, liquidationLTV: 7500n, initialLiquidationLTV: 7500n }),
      ],
    }
    const resolver = makeResolver({
      '0xlow': makeCollateral('0xlow', 1n),
      '0xhigh': makeCollateral('0xhigh', 1n),
      '0xmid': makeCollateral('0xmid', 1n),
    })

    const pairs = getCollateralExposurePairs(vault, resolver, RAMP_COMPLETE)

    expect(pairs.map(p => p.collateral.address)).toEqual(['0xhigh', '0xmid', '0xlow'])
  })

  it('returns an empty array when vault has no collateral LTVs', () => {
    const vault = { collateralLTVs: [] }
    const resolver = makeResolver({})
    expect(getCollateralExposurePairs(vault, resolver, NOW)).toEqual([])
  })

  it('honours the nowSeconds override for ramp-down math', () => {
    // Before the ramp starts, initial LTV caps liquidation at 9000 → live.
    const vault = { collateralLTVs: [rampingDownLtv('0xaaa')] }
    const resolver = makeResolver({ '0xaaa': makeCollateral('0xaaa', 1_000n) })

    expect(getCollateralExposurePairs(vault, resolver, BEFORE_RAMP)).toHaveLength(1)
    // After the ramp completes, current LTV drops to target=7000 → still live.
    expect(getCollateralExposurePairs(vault, resolver, RAMP_COMPLETE)).toHaveLength(1)
  })
})

describe('hasCollateralExposure', () => {
  it('returns true when any collateral pair is live (borrowable)', () => {
    const vault = { collateralLTVs: [borrowableLtv('0xaaa')] }
    const resolver = makeResolver({ '0xaaa': makeCollateral('0xaaa', 0n) })
    expect(hasCollateralExposure(vault, resolver, NOW)).toBe(true)
  })

  it('returns true when any collateral pair is mid ramp-down with outstanding supply', () => {
    const vault = { collateralLTVs: [rampingDownLtv('0xaaa')] }
    const resolver = makeResolver({ '0xaaa': makeCollateral('0xaaa', 1_000n) })
    expect(hasCollateralExposure(vault, resolver, NOW)).toBe(true)
  })

  it('returns false when all pairs are fully ramped down', () => {
    const vault = {
      collateralLTVs: [fullyRampedDownLtv('0xaaa'), fullyRampedDownLtv('0xbbb')],
    }
    const resolver = makeResolver({
      '0xaaa': makeCollateral('0xaaa', 1_000n),
      '0xbbb': makeCollateral('0xbbb', 1_000n),
    })
    // RAMP_COMPLETE > targetTimestamp so current LTV settles at 0 for both.
    expect(hasCollateralExposure(vault, resolver, RAMP_COMPLETE)).toBe(false)
  })

  it('returns false when ramping pairs have no remaining supply', () => {
    const vault = { collateralLTVs: [rampingDownLtv('0xaaa')] }
    const resolver = makeResolver({ '0xaaa': makeCollateral('0xaaa', 0n) })
    expect(hasCollateralExposure(vault, resolver, NOW)).toBe(false)
  })

  it('returns false when collateral is unresolved', () => {
    const vault = { collateralLTVs: [borrowableLtv('0xaaa')] }
    const resolver = makeResolver({})
    expect(hasCollateralExposure(vault, resolver, NOW)).toBe(false)
  })

  it('returns false for a vault with no collateral LTVs (collateral-only / escrow)', () => {
    const vault = { collateralLTVs: [] }
    const resolver = makeResolver({})
    expect(hasCollateralExposure(vault, resolver, NOW)).toBe(false)
  })

  it('short-circuits: at least one live pair makes the whole vault "exposed"', () => {
    const vault = {
      collateralLTVs: [
        fullyRampedDownLtv('0xdead'),
        borrowableLtv('0xlive'),
        fullyRampedDownLtv('0xalsodead'),
      ],
    }
    const resolver = makeResolver({
      '0xdead': makeCollateral('0xdead', 0n),
      '0xlive': makeCollateral('0xlive', 0n),
      '0xalsodead': makeCollateral('0xalsodead', 0n),
    })
    expect(hasCollateralExposure(vault, resolver, NOW)).toBe(true)
  })
})
