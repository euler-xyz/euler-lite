import { describe, it, expect } from 'vitest'
import {
  getCollateralExposureGroups,
  getCollateralExposurePairs,
  hasCollateralExposure,
  type CollateralVaultResolver,
} from '~/utils/vault/collateral-exposure'
import type { EVault, SecuritizeCollateralVault, EVaultCollateral } from '@eulerxyz/euler-v2-sdk'

/**
 * Build a EVaultCollateral with reasonable defaults. By default the
 * liquidation LTV has fully ramped down to 0 — tests opt in to live config by
 * overriding the fields they care about.
 */
const makeLtv = (overrides: Partial<Omit<EVaultCollateral, 'address'>> & { address?: string } = {}): EVaultCollateral => ({
  address: '0xcoll0000000000000000000000000000000000000',
  borrowLTV: 0,
  liquidationLTV: 0,
  currentLiquidationLTV: 0,
  isLiquidationLTVRamping: false,
  rampTimeRemaining: 0n,
  oraclePriceRaw: {
    amountIn: 0n,
    amountOutMid: 0n,
    amountOutBid: 0n,
    amountOutAsk: 0n,
    timestamp: 0,
  },
  ...overrides,
}) as unknown as EVaultCollateral

/**
 * Minimal collateral vault for assertion; the predicate only reads
 * `totalAssets`, but we stamp an address so callers can distinguish pairs in
 * the returned array.
 */
const makeCollateral = (
  address: string,
  totalAssets: bigint,
  asset: Partial<EVault['asset']> = {},
): EVault | SecuritizeCollateralVault =>
  ({
    address,
    totalAssets,
    asset: {
      address,
      symbol: address,
      decimals: 18,
      name: address,
      ...asset,
    },
  } as unknown as EVault)

/**
 * Build a resolver that returns the collateral at a given address, or
 * undefined if it wasn't registered. This matches the contract of the real
 * `useVaultRegistry().get(addr)?.vault` lookup.
 */
const makeResolver = (
  entries: Record<string, EVault | SecuritizeCollateralVault>,
): CollateralVaultResolver => addr => entries[addr]

const borrowableLtv = (collateralAddress: string): EVaultCollateral =>
  makeLtv({
    address: collateralAddress,
    borrowLTV: 0.75,
    liquidationLTV: 0.8,
    currentLiquidationLTV: 0.8,
  })

const rampingDownLtv = (collateralAddress: string): EVaultCollateral =>
  makeLtv({
    address: collateralAddress,
    borrowLTV: 0, // no new borrows allowed
    liquidationLTV: 0.7, // target
    currentLiquidationLTV: 0.8,
    isLiquidationLTVRamping: true,
    rampTimeRemaining: 500n,
  })

const fullyRampedDownLtv = (collateralAddress: string): EVaultCollateral =>
  makeLtv({
    address: collateralAddress,
    borrowLTV: 0,
    liquidationLTV: 0,
    currentLiquidationLTV: 0,
  })

describe('getCollateralExposurePairs', () => {
  it('returns pairs that are currently borrowable', () => {
    const vault = { collaterals: [borrowableLtv('0xaaa')] }
    const resolver = makeResolver({ '0xaaa': makeCollateral('0xaaa', 1_000n) })
    const pairs = getCollateralExposurePairs(vault, resolver)

    expect(pairs).toHaveLength(1)
    expect(pairs[0].collateral.address).toBe('0xaaa')
    expect(pairs[0].ltv.borrowLTV).toBe(0.75)
  })

  it('includes pairs where borrowLTV is 0 but the collateral has outstanding supply during ramp-down', () => {
    const vault = { collaterals: [rampingDownLtv('0xaaa')] }
    const resolver = makeResolver({ '0xaaa': makeCollateral('0xaaa', 1_000n) })
    const pairs = getCollateralExposurePairs(vault, resolver)

    // borrowLTV == 0 but collateral has supply → open interest can still
    // accrue while liquidation LTV ramps down, so the pair must be kept.
    expect(pairs).toHaveLength(1)
    expect(pairs[0].ltv.borrowLTV).toBe(0)
  })

  it('excludes pairs that have fully ramped down', () => {
    const vault = { collaterals: [fullyRampedDownLtv('0xaaa')] }
    const resolver = makeResolver({ '0xaaa': makeCollateral('0xaaa', 1_000n) })
    const pairs = getCollateralExposurePairs(vault, resolver)

    // currentLiquidationLTV == 0 → no exposure regardless of supply.
    expect(pairs).toHaveLength(0)
  })

  it('keeps a pair mid ramp-down with outstanding supply even when the target LTV is 0', () => {
    const vault = { collaterals: [fullyRampedDownLtv('0xaaa')] }
    Object.defineProperty(vault.collaterals[0], 'currentLiquidationLTV', { value: 0.45, configurable: true })
    const resolver = makeResolver({ '0xaaa': makeCollateral('0xaaa', 1_000n) })
    const pairs = getCollateralExposurePairs(vault, resolver)

    expect(pairs).toHaveLength(1)
  })

  it('excludes pairs with borrowLTV 0 and no collateral supply', () => {
    const vault = { collaterals: [rampingDownLtv('0xaaa')] }
    const resolver = makeResolver({ '0xaaa': makeCollateral('0xaaa', 0n) })
    const pairs = getCollateralExposurePairs(vault, resolver)

    // Not borrowable now, and no open interest possible without supply.
    expect(pairs).toHaveLength(0)
  })

  it('skips pairs whose collateral is not in the registry', () => {
    const vault = {
      collaterals: [borrowableLtv('0xaaa'), borrowableLtv('0xbbb')],
    }
    const resolver = makeResolver({ '0xaaa': makeCollateral('0xaaa', 1_000n) })
    const pairs = getCollateralExposurePairs(vault, resolver)

    expect(pairs).toHaveLength(1)
    expect(pairs[0].collateral.address).toBe('0xaaa')
  })

  it('sorts pairs by borrowLTV descending', () => {
    const vault = {
      collaterals: [
        makeLtv({ address: '0xlow', borrowLTV: 0.5, liquidationLTV: 0.6, currentLiquidationLTV: 0.6 }),
        makeLtv({ address: '0xhigh', borrowLTV: 0.85, liquidationLTV: 0.9, currentLiquidationLTV: 0.9 }),
        makeLtv({ address: '0xmid', borrowLTV: 0.7, liquidationLTV: 0.75, currentLiquidationLTV: 0.75 }),
      ],
    }
    const resolver = makeResolver({
      '0xlow': makeCollateral('0xlow', 1n),
      '0xhigh': makeCollateral('0xhigh', 1n),
      '0xmid': makeCollateral('0xmid', 1n),
    })

    const pairs = getCollateralExposurePairs(vault, resolver)

    expect(pairs.map(p => p.collateral.address)).toEqual(['0xhigh', '0xmid', '0xlow'])
  })

  it('returns an empty array when vault has no collateral LTVs', () => {
    const vault = { collaterals: [] }
    const resolver = makeResolver({})
    expect(getCollateralExposurePairs(vault, resolver)).toEqual([])
  })

  it('uses SDK current liquidation LTV for ramp-down liveness', () => {
    const vault = { collaterals: [rampingDownLtv('0xaaa')] }
    const resolver = makeResolver({ '0xaaa': makeCollateral('0xaaa', 1_000n) })

    expect(getCollateralExposurePairs(vault, resolver)).toHaveLength(1)
    Object.defineProperty(vault.collaterals[0], 'currentLiquidationLTV', { value: 0, configurable: true })
    expect(getCollateralExposurePairs(vault, resolver)).toHaveLength(0)
  })
})

describe('hasCollateralExposure', () => {
  it('returns true when any collateral pair is live (borrowable)', () => {
    const vault = { collaterals: [borrowableLtv('0xaaa')] }
    const resolver = makeResolver({ '0xaaa': makeCollateral('0xaaa', 0n) })
    expect(hasCollateralExposure(vault, resolver)).toBe(true)
  })

  it('returns true when any collateral pair is mid ramp-down with outstanding supply', () => {
    const vault = { collaterals: [rampingDownLtv('0xaaa')] }
    const resolver = makeResolver({ '0xaaa': makeCollateral('0xaaa', 1_000n) })
    expect(hasCollateralExposure(vault, resolver)).toBe(true)
  })

  it('returns false when all pairs are fully ramped down', () => {
    const vault = {
      collaterals: [fullyRampedDownLtv('0xaaa'), fullyRampedDownLtv('0xbbb')],
    }
    const resolver = makeResolver({
      '0xaaa': makeCollateral('0xaaa', 1_000n),
      '0xbbb': makeCollateral('0xbbb', 1_000n),
    })
    expect(hasCollateralExposure(vault, resolver)).toBe(false)
  })

  it('returns false when ramping pairs have no remaining supply', () => {
    const vault = { collaterals: [rampingDownLtv('0xaaa')] }
    const resolver = makeResolver({ '0xaaa': makeCollateral('0xaaa', 0n) })
    expect(hasCollateralExposure(vault, resolver)).toBe(false)
  })

  it('returns false when collateral is unresolved', () => {
    const vault = { collaterals: [borrowableLtv('0xaaa')] }
    const resolver = makeResolver({})
    expect(hasCollateralExposure(vault, resolver)).toBe(false)
  })

  it('returns false for a vault with no collateral LTVs (collateral-only / escrow)', () => {
    const vault = { collaterals: [] }
    const resolver = makeResolver({})
    expect(hasCollateralExposure(vault, resolver)).toBe(false)
  })

  it('short-circuits: at least one live pair makes the whole vault "exposed"', () => {
    const vault = {
      collaterals: [
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
    expect(hasCollateralExposure(vault, resolver)).toBe(true)
  })
})

describe('getCollateralExposureGroups', () => {
  it('groups duplicate collateral vaults by backing asset', () => {
    const pairs = [
      {
        collateral: makeCollateral('0xvault1', 1n, {
          address: '0x000000000000000000000000000000000000000a',
          symbol: 'USDC',
        }),
        ltv: borrowableLtv('0xvault1'),
      },
      {
        collateral: makeCollateral('0xvault2', 1n, {
          address: '0x000000000000000000000000000000000000000a',
          symbol: 'USDC',
        }),
        ltv: makeLtv({
          address: '0xvault2',
          borrowLTV: 0.7,
          liquidationLTV: 0.82,
          currentLiquidationLTV: 0.82,
        }),
      },
      {
        collateral: makeCollateral('0xvault3', 1n, {
          address: '0x000000000000000000000000000000000000000b',
          symbol: 'WETH',
        }),
        ltv: makeLtv({
          address: '0xvault3',
          borrowLTV: 0.5,
          liquidationLTV: 0.6,
          currentLiquidationLTV: 0.6,
        }),
      },
    ]

    const groups = getCollateralExposureGroups(pairs)

    expect(groups).toHaveLength(2)
    expect(groups[0].asset.symbol).toBe('USDC')
    expect(groups[0].vaultCount).toBe(2)
    expect(groups[0].items).toHaveLength(2)
    expect(groups[0].maxCurrentLiquidationLTV).toBe(0.82)
    expect(groups[1].asset.symbol).toBe('WETH')
  })
})
