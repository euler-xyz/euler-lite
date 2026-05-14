import { describe, expect, it } from 'vitest'
import {
  getFreeSubAccounts,
  getPositionRampStatus,
  getSubAccountAddress,
  isBorrowControllerCompatible,
  isPositionLiquidationLTVRamping,
  selectBorrowCompatibleSubAccount,
  type AccountBorrowPosition,
} from '~/entities/account'

// Build a minimally-typed position; only the fields the helpers read matter.
const makePosition = (overrides: Partial<AccountBorrowPosition> = {}): AccountBorrowPosition => ({
  // ramp config (BPS): initial 90%, target 80%, ramps over 1000s ending at t=2000
  initialLiquidationLTV: 9000n,
  targetLiquidationLTV: 8000n,
  targetTimestamp: 2000n,
  rampDuration: 1000n,
  // userLTV uses scale 18, so 70% = 70e18
  userLTV: 70n * 10n ** 18n,
  liquidationLTV: 8500n, // mid-ramp effective (BPS)
  // unused-by-helpers placeholders
  borrow: {} as AccountBorrowPosition['borrow'],
  collateral: {} as AccountBorrowPosition['collateral'],
  subAccount: '0x',
  health: 0n,
  price: 0n,
  supplied: 0n,
  borrowed: 0n,
  borrowLTV: 0n,
  liabilityValueBorrowing: 0n,
  liabilityValueLiquidation: 0n,
  timeToLiquidation: 0n,
  collateralValueLiquidation: 0n,
  ...overrides,
})

describe('isPositionLiquidationLTVRamping', () => {
  it('detects in-flight ramp', () => {
    const p = makePosition()
    expect(isPositionLiquidationLTVRamping(p, 1500n)).toBe(true)
  })

  it('reports complete after targetTimestamp', () => {
    const p = makePosition()
    expect(isPositionLiquidationLTVRamping(p, 2500n)).toBe(false)
  })

  it('reports false when there is no ramp (target >= initial)', () => {
    const p = makePosition({ initialLiquidationLTV: 8000n })
    expect(isPositionLiquidationLTVRamping(p, 1500n)).toBe(false)
  })
})

describe('getPositionRampStatus', () => {
  it('returns no-danger when userLTV stays below the post-ramp target', () => {
    const p = makePosition({ userLTV: 70n * 10n ** 18n }) // 70% < 80% target
    const status = getPositionRampStatus(p, 1500n)
    expect(status).toEqual({ isRamping: true, willBeLiquidated: false, forcedLiquidationAt: null })
  })

  it('flags danger when userLTV is between target and initial', () => {
    const p = makePosition({ userLTV: 85n * 10n ** 18n }) // 85% — crosses LLTV mid-ramp
    const status = getPositionRampStatus(p, 1500n)
    expect(status.isRamping).toBe(true)
    expect(status.willBeLiquidated).toBe(true)
    // current effective at t=1500 is (8000 + (9000-8000) * (2000-1500)/1000) = 8500
    // crossing where effective(t) == 8500 happens at t = 2000 - (8500-8000)*1000/(9000-8000) = 1500
    expect(status.forcedLiquidationAt).toBe(1500n)
  })

  it('flags danger and returns targetTimestamp when userLTV is exactly the post-ramp target', () => {
    const p = makePosition({ userLTV: 80n * 10n ** 18n })
    const status = getPositionRampStatus(p, 1500n)
    expect(status.willBeLiquidated).toBe(true)
    expect(status.forcedLiquidationAt).toBe(2000n)
  })

  it('returns no-danger when ramp has already completed', () => {
    const p = makePosition({ userLTV: 95n * 10n ** 18n })
    const status = getPositionRampStatus(p, 2500n)
    expect(status.isRamping).toBe(false)
    expect(status.willBeLiquidated).toBe(false)
  })

  it('is robust to degenerate ramp (target equals initial)', () => {
    const p = makePosition({ initialLiquidationLTV: 8000n, userLTV: 85n * 10n ** 18n })
    const status = getPositionRampStatus(p, 1500n)
    expect(status.isRamping).toBe(false)
  })
})

describe('getFreeSubAccounts', () => {
  it('returns free sub-accounts in index order', () => {
    const owner = '0x1111111111111111111111111111111111111111'
    const occupied = [
      getSubAccountAddress(owner, 1),
      getSubAccountAddress(owner, 3),
    ]

    const free = getFreeSubAccounts(owner, occupied)

    expect(free[0]).toBe(getSubAccountAddress(owner, 2))
    expect(free[1]).toBe(getSubAccountAddress(owner, 4))
  })
})

describe('isBorrowControllerCompatible', () => {
  const borrowVault = '0x2222222222222222222222222222222222222222'

  it('accepts accounts without controllers', () => {
    expect(isBorrowControllerCompatible([], borrowVault)).toBe(true)
  })

  it('accepts accounts controlled by the target borrow vault', () => {
    expect(isBorrowControllerCompatible([borrowVault], borrowVault)).toBe(true)
  })

  it('rejects accounts controlled by a different vault', () => {
    expect(
      isBorrowControllerCompatible(
        ['0x3333333333333333333333333333333333333333'],
        borrowVault,
      ),
    ).toBe(false)
  })

  it('rejects accounts with mixed controllers', () => {
    expect(
      isBorrowControllerCompatible(
        [borrowVault, '0x3333333333333333333333333333333333333333'],
        borrowVault,
      ),
    ).toBe(false)
  })
})

describe('selectBorrowCompatibleSubAccount', () => {
  const borrowVault = '0x2222222222222222222222222222222222222222'

  it('skips empty sub-accounts with an incompatible controller and picks the next compatible one', () => {
    const selected = selectBorrowCompatibleSubAccount([
      {
        subAccount: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        enabledControllers: ['0x3333333333333333333333333333333333333333'],
      },
      {
        subAccount: '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
        enabledControllers: [],
      },
    ], borrowVault)

    expect(selected).toBe('0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')
  })

  it('accepts a free sub-account already controlled by the target debt vault', () => {
    const selected = selectBorrowCompatibleSubAccount([
      {
        subAccount: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        enabledControllers: [borrowVault],
      },
    ], borrowVault)

    expect(selected).toBe('0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')
  })

  it('returns null when no compatible sub-account exists', () => {
    const selected = selectBorrowCompatibleSubAccount([
      {
        subAccount: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        enabledControllers: ['0x3333333333333333333333333333333333333333'],
      },
    ], borrowVault)

    expect(selected).toBeNull()
  })
})
