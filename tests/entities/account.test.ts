import type { EVault, EVaultCollateral, EVaultCollateralRamping, IHasVaultAddress, PortfolioBorrowPosition } from '@eulerxyz/euler-v2-sdk'
import { describe, expect, it } from 'vitest'
import { getPositionCollateralEdge, getPositionRampStatus, getRampStatus, type PositionRampInput } from '~/entities/account'

const WAD = 10n ** 18n

// 70% as a WAD bigint (0.7 * 1e18).
const pctWad = (percent: number): bigint =>
  BigInt(Math.round(percent * Number(WAD) / 100))

// Default ramp: target 80%, initial 90%, ends at t=2000, ramps over 1000s.
const defaultRamping: EVaultCollateralRamping = {
  initialLiquidationLTV: 0.9,
  targetTimestamp: 2000,
  rampDuration: 1000n,
}

const makeInput = (overrides: Partial<PositionRampInput> = {}): PositionRampInput => ({
  userLTV: pctWad(70),
  liquidationLTV: 0.8,
  ramping: defaultRamping,
  ...overrides,
})

const makeCollateralEdge = (overrides: Partial<EVaultCollateral> = {}): EVaultCollateral => ({
  address: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  borrowLTV: 0,
  liquidationLTV: 0.8,
  ramping: defaultRamping,
  oraclePriceRaw: undefined,
  currentLiquidationLTV: 0.85,
  isLiquidationLTVRamping: true,
  rampTimeRemaining: 500n,
  ...overrides,
} as EVaultCollateral)

const makePosition = (
  edge = makeCollateralEdge(),
  overrides: Partial<PortfolioBorrowPosition<IHasVaultAddress>> = {},
): PortfolioBorrowPosition<IHasVaultAddress> => ({
  userLTV: pctWad(70),
  borrowVault: { collaterals: [edge] } as EVault,
  collateralVault: { address: edge.address.toUpperCase() } as IHasVaultAddress,
  ...overrides,
} as PortfolioBorrowPosition<IHasVaultAddress>)

describe('getRampStatus — ramping detection', () => {
  it('detects in-flight ramp', () => {
    const status = getRampStatus(makeInput(), 1500n)
    expect(status.isRamping).toBe(true)
  })

  it('reports not ramping after targetTimestamp', () => {
    const status = getRampStatus(makeInput(), 2500n)
    expect(status.isRamping).toBe(false)
  })

  it('reports not ramping when there is no ramping config', () => {
    const status = getRampStatus(makeInput({ ramping: undefined }), 1500n)
    expect(status.isRamping).toBe(false)
  })

  it('reports not ramping when target >= initial (no actual decrease)', () => {
    const status = getRampStatus(makeInput({
      liquidationLTV: 0.9,
      ramping: { ...defaultRamping, initialLiquidationLTV: 0.9 },
    }), 1500n)
    expect(status.isRamping).toBe(false)
  })

  it('reports not ramping when rampDuration is zero', () => {
    const status = getRampStatus(makeInput({
      ramping: { ...defaultRamping, rampDuration: 0n },
    }), 1500n)
    expect(status.isRamping).toBe(false)
  })
})

describe('getRampStatus — forced-liquidation projection', () => {
  it('returns no-danger when userLTV stays below the post-ramp target', () => {
    // 70% < 80% target
    const status = getRampStatus(makeInput({ userLTV: pctWad(70) }), 1500n)
    expect(status).toEqual({ isRamping: true, willBeLiquidated: false, forcedLiquidationAt: null })
  })

  it('flags danger when userLTV is between target and initial', () => {
    // 85% — crosses LLTV mid-ramp.
    // Current effective LLTV at t=1500: 80% + (90% - 80%) * (2000-1500)/1000 = 85%.
    // Crossing where effective(t) == 85%: t = 2000 - (85-80)*1000/(90-80) = 1500.
    const status = getRampStatus(makeInput({ userLTV: pctWad(85) }), 1500n)
    expect(status.isRamping).toBe(true)
    expect(status.willBeLiquidated).toBe(true)
    expect(status.forcedLiquidationAt).toBe(1500n)
  })

  it('flags danger and returns targetTimestamp when userLTV is exactly the post-ramp target', () => {
    const status = getRampStatus(makeInput({ userLTV: pctWad(80) }), 1500n)
    expect(status.willBeLiquidated).toBe(true)
    expect(status.forcedLiquidationAt).toBe(2000n)
  })

  it('returns no-danger when ramp has already completed', () => {
    const status = getRampStatus(makeInput({ userLTV: pctWad(95) }), 2500n)
    expect(status.isRamping).toBe(false)
    expect(status.willBeLiquidated).toBe(false)
    expect(status.forcedLiquidationAt).toBeNull()
  })

  it('returns danger when userLTV already exceeds the initial LLTV (cross is at or before now)', () => {
    // 95% > 90% initial — already past current effective LLTV.
    const status = getRampStatus(makeInput({ userLTV: pctWad(95) }), 1500n)
    expect(status.willBeLiquidated).toBe(true)
    // forcedLiquidationAt projects to a timestamp <= now; caller treats it as "now".
    expect(status.forcedLiquidationAt).not.toBeNull()
    expect(status.forcedLiquidationAt!).toBeLessThanOrEqual(1500n)
  })
})

describe('getPositionCollateralEdge', () => {
  it('matches the primary collateral edge case-insensitively', () => {
    const edge = makeCollateralEdge()
    const position = makePosition(edge)

    expect(
      getPositionCollateralEdge(position.borrowVault as EVault, position.collateralVault?.address),
    ).toBe(edge)
  })

  it('returns undefined when the borrow vault does not expose a matching collateral edge', () => {
    const edge = makeCollateralEdge()
    const position = makePosition(edge, {
      borrowVault: { collaterals: [makeCollateralEdge({ address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' })] } as EVault,
    })

    expect(
      getPositionCollateralEdge(position.borrowVault as EVault, position.collateralVault?.address),
    ).toBeUndefined()
  })
})

describe('getPositionRampStatus', () => {
  it('detects ramping SDK collateral edges from the position borrow vault', () => {
    const status = getPositionRampStatus(makePosition(), 1500n)

    expect(status).toEqual({ isRamping: true, willBeLiquidated: false, forcedLiquidationAt: null })
  })

  it('returns non-ramping when the matching collateral edge is missing', () => {
    const position = makePosition(makeCollateralEdge(), {
      collateralVault: { address: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' } as IHasVaultAddress,
    })

    expect(getPositionRampStatus(position, 1500n)).toEqual({
      isRamping: false,
      willBeLiquidated: false,
      forcedLiquidationAt: null,
    })
  })
})
