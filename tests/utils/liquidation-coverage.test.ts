import { VaultType } from '@eulerxyz/euler-v2-sdk'
import { describe, expect, it } from 'vitest'
import {
  getLiquidationCoverageWarning,
  hasBorrowSide,
  isCoveredByDefaultBot,
  LIQUIDATION_COVERAGE_BADGE_LABEL,
  parseVaultFilter,
  type LiquidationCoverage,
} from '~/utils/liquidation-coverage'

const LISTED = '0x692b9F0C2701699b7a352C9331DFAE6A6a163294'
const OTHER = '0x0120c2748545a4D9C875CDdFB439f786d6f1B460'

const answered = (mode: 'none' | 'blacklist' | 'whitelist', vaults: string[]): LiquidationCoverage => ({
  enabled: true,
  chainId: 8453,
  state: 'answered',
  mode,
  vaults,
  fetchedAt: 1,
})

describe('parseVaultFilter', () => {
  it('reads both item shapes, lowercases the addresses and drops the reasons', () => {
    expect(parseVaultFilter({
      mode: 'Blacklist',
      items: [LISTED, { address: OTHER, reason: 'Operator note naming a third party.' }],
    })).toEqual({
      mode: 'blacklist',
      vaults: [LISTED.toLowerCase(), OTHER.toLowerCase()],
    })
  })

  it('reads the whitelist and an empty filter', () => {
    expect(parseVaultFilter({ mode: 'Whitelist', items: [{ address: LISTED }] }))
      .toEqual({ mode: 'whitelist', vaults: [LISTED.toLowerCase()] })
    expect(parseVaultFilter({ mode: 'None', items: [] })).toEqual({ mode: 'none', vaults: [] })
  })

  it.each([
    ['a missing body', null],
    ['an unknown mode', { mode: 'blacklist', items: [] }],
    ['a mode named after an object property', { mode: 'constructor', items: [] }],
    ['a mode named after the prototype', { mode: '__proto__', items: [] }],
    ['a mode named after a method', { mode: 'toString', items: [] }],
    ['items that are not a list', { mode: 'Blacklist', items: {} }],
    ['a malformed address', { mode: 'Blacklist', items: ['0x1234'] }],
    ['an item without an address', { mode: 'Blacklist', items: [{ reason: 'x' }] }],
    ['a non-string reason', { mode: 'Blacklist', items: [{ address: LISTED, reason: 7 }] }],
    ['too many items', { mode: 'Blacklist', items: Array.from({ length: 2001 }, () => LISTED) }],
  ])('refuses %s', (_name, payload) => {
    expect(parseVaultFilter(payload)).toBeNull()
  })
})

describe('isCoveredByDefaultBot', () => {
  it('follows the filter mode', () => {
    expect(isCoveredByDefaultBot(answered('blacklist', [LISTED.toLowerCase()]), LISTED)).toBe(false)
    expect(isCoveredByDefaultBot(answered('blacklist', [LISTED.toLowerCase()]), OTHER)).toBe(true)
    expect(isCoveredByDefaultBot(answered('whitelist', [LISTED.toLowerCase()]), LISTED)).toBe(true)
    expect(isCoveredByDefaultBot(answered('whitelist', [LISTED.toLowerCase()]), OTHER)).toBe(false)
    expect(isCoveredByDefaultBot(answered('none', []), LISTED)).toBe(true)
  })

  it('covers nothing on a chain whose bot does not answer', () => {
    expect(isCoveredByDefaultBot({ enabled: true, chainId: 239, state: 'no-bot' }, LISTED)).toBe(false)
  })

  it('knows nothing while the feature is off or the coverage has not loaded', () => {
    expect(isCoveredByDefaultBot({ enabled: false }, LISTED)).toBeNull()
    expect(isCoveredByDefaultBot(undefined, LISTED)).toBeNull()
  })
})

describe('hasBorrowSide', () => {
  const evault = (isBorrowable: boolean, totalBorrowed: bigint) =>
    ({ type: VaultType.EVault, address: LISTED, isBorrowable, totalBorrowed })

  it('is true for an EVK vault that lends or still carries debt', () => {
    expect(hasBorrowSide(evault(true, 0n))).toBe(true)
    expect(hasBorrowSide(evault(false, 5n))).toBe(true)
  })

  it('is false for a collateral-only EVK vault and for any other vault type', () => {
    expect(hasBorrowSide(evault(false, 0n))).toBe(false)
    expect(hasBorrowSide({ ...evault(true, 5n), type: VaultType.EulerEarn })).toBe(false)
    expect(hasBorrowSide({ address: LISTED })).toBe(false)
  })
})

describe('getLiquidationCoverageWarning', () => {
  it('speaks for the default bot only and never says a position cannot be liquidated', () => {
    for (const context of ['lend', 'borrow'] as const) {
      const warning = getLiquidationCoverageWarning(context)
      expect(warning.level).toBe('high')
      expect(warning.title).toBe(LIQUIDATION_COVERAGE_BADGE_LABEL)
      expect(warning.message).toContain('The default liquidation bot does not cover borrows from this vault.')
      expect(warning.message).not.toMatch(/euler|cannot be liquidated/i)
    }
  })

  it('tells lenders where the risk lands and borrowers that others may still liquidate', () => {
    expect(getLiquidationCoverageWarning('lend').message).toContain('can reach lenders')
    expect(getLiquidationCoverageWarning('borrow').message).toContain('Other liquidators may still liquidate your position')
  })
})
