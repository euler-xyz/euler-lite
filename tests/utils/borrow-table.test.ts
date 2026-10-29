import { describe, expect, it, vi } from 'vitest'
import { VaultType, type EVault, type SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { hasBorrowTablePair, isBorrowTableCollateral, isBorrowTablePair, isExploreListedMarket, isLendTableVault } from '~/utils/vault/borrow-table'

const borrowHidden = vi.hoisted(() => new Set<string>())
const lendHidden = vi.hoisted(() => new Set<string>())
const depositsOff = vi.hoisted(() => new Set<string>())
const borrowsOff = vi.hoisted(() => new Set<string>())
const transfersOff = vi.hoisted(() => new Set<string>())
const unknown = vi.hoisted(() => new Set<string>())
const deprecated = vi.hoisted(() => new Set<string>())

vi.mock('~/utils/eulerLabelsUtils', () => ({
  isVaultNotExplorableBorrow: (address: string) => borrowHidden.has(address),
  isVaultNotExplorableLend: (address: string) => lendHidden.has(address),
  isVaultDeprecated: (address: string) => deprecated.has(address),
}))
vi.mock('~/utils/vault-hooks', () => ({
  OP_BORROW: 'borrow',
  OP_DEPOSIT: 'deposit',
  OP_TRANSFER: 'transfer',
  isOpDisabled: (vault: { address: string }, op: string) => ({ borrow: borrowsOff, deposit: depositsOff, transfer: transfersOff })[op]?.has(vault.address) ?? false,
}))
vi.mock('~/composables/useVaultRegistry', () => ({
  useVaultRegistry: () => ({ isVerifiedVault: (address: string) => !unknown.has(address) }),
}))

const pair = (borrow: string, collateral: string) =>
  ({ borrow: { address: borrow }, collateral: { address: collateral } }) as unknown as AnyBorrowVaultPair

describe('isBorrowTableCollateral', () => {
  it('follows the collateral borrow-side listing unless all label entries are shown', () => {
    borrowHidden.add('0xHidden')

    expect(isBorrowTableCollateral('0xListed', false)).toBe(true)
    expect(isBorrowTableCollateral('0xHidden', false)).toBe(false)
    expect(isBorrowTableCollateral('0xHidden', true)).toBe(true)
  })

  it('leaves out an Unknown collateral, one no published label verifies, unless all label entries are shown', () => {
    unknown.add('0xUnlabeled')

    expect(isBorrowTableCollateral('0xUnlabeled', false)).toBe(false)
    expect(isBorrowTableCollateral('0xUnlabeled', true)).toBe(true)
  })

  it('does not list a lend vault whose only pair uses an Unknown collateral', () => {
    unknown.add('0xUnlabeled')
    const isListed = (address: string) => isBorrowTableCollateral(address, false)

    expect(hasBorrowTablePair('0xLend', [pair('0xLend', '0xUnlabeled')], isListed)).toBe(false)
    expect(hasBorrowTablePair('0xLend', [pair('0xLend', '0xUnlabeled'), pair('0xLend', '0xListed')], isListed)).toBe(true)
  })
})

describe('hasBorrowTablePair', () => {
  const isListed = (address: string) => address !== '0xHidden'

  it('needs a pair of this vault whose collateral the Borrow table lists', () => {
    expect(hasBorrowTablePair('0xLend', [pair('0xLend', '0xListed')], isListed)).toBe(true)
    expect(hasBorrowTablePair('0xLend', [pair('0xLend', '0xHidden')], isListed)).toBe(false)
    expect(hasBorrowTablePair('0xLend', [pair('0xLend', '0xHidden'), pair('0xLend', '0xListed')], isListed)).toBe(true)
  })

  it('ignores pairs of other vaults', () => {
    expect(hasBorrowTablePair('0xLend', [pair('0xOther', '0xListed')], isListed)).toBe(false)
  })

  it('matches the vault address regardless of letter case', () => {
    expect(hasBorrowTablePair('0xlend', [pair('0xLEND', '0xListed')], isListed)).toBe(true)
  })
})

const evault = (address: string) => ({ type: VaultType.EVault, address }) as unknown as EVault
const securitize = (address: string) => ({ type: VaultType.SecuritizeCollateral, address }) as unknown as SecuritizeCollateralVault

describe('isLendTableVault', () => {
  it('lists a vault that lends against a Borrow-table collateral and takes deposits', () => {
    expect(isLendTableVault(evault('0xLend'), [pair('0xLend', '0xListed')], false)).toBe(true)
  })

  it('does not list a vault without a Borrow-table pair, closed to deposits, or hidden from Lend', () => {
    unknown.add('0xUnlabeled')
    depositsOff.add('0xClosed')
    lendHidden.add('0xNotLend')

    expect(isLendTableVault(evault('0xLend'), [pair('0xLend', '0xUnlabeled')], false)).toBe(false)
    expect(isLendTableVault(evault('0xClosed'), [pair('0xClosed', '0xListed')], false)).toBe(false)
    expect(isLendTableVault(evault('0xNotLend'), [pair('0xNotLend', '0xListed')], false)).toBe(false)
    expect(isLendTableVault(evault('0xNotLend'), [pair('0xNotLend', '0xListed')], true)).toBe(true)
  })
})

describe('isBorrowTablePair', () => {
  const evPair = (borrow: string, collateral: string) =>
    ({ borrow: evault(borrow), collateral: evault(collateral), ltv: { borrowLTV: 0.8 } }) as unknown as AnyBorrowVaultPair

  it('lists a pair whose borrow vault is listed for Borrow and whose collateral the Borrow table lists', () => {
    expect(isBorrowTablePair(evPair('0xBorrow', '0xListed'), false)).toBe(true)
  })

  it('does not list a pair whose borrow vault is hidden from Borrow, unless all label entries are shown', () => {
    borrowHidden.add('0xHiddenBorrow')
    expect(isBorrowTablePair(evPair('0xHiddenBorrow', '0xListed'), false)).toBe(false)
    expect(isBorrowTablePair(evPair('0xHiddenBorrow', '0xListed'), true)).toBe(true)
  })

  it('does not list a pair that cannot be borrowed or whose collateral cannot be added either way', () => {
    borrowsOff.add('0xNoBorrow')
    depositsOff.add('0xLockedCollateral')
    transfersOff.add('0xLockedCollateral')
    depositsOff.add('0xDepositOnlyOff')

    expect(isBorrowTablePair(evPair('0xNoBorrow', '0xListed'), false)).toBe(false)
    expect(isBorrowTablePair(evPair('0xBorrow', '0xLockedCollateral'), false)).toBe(false)
    expect(isBorrowTablePair(evPair('0xBorrow', '0xDepositOnlyOff'), false)).toBe(true)
  })
})

describe('isExploreListedMarket', () => {
  const evPair = (borrow: string, collateral: string) =>
    ({ borrow: evault(borrow), collateral: evault(collateral), ltv: { borrowLTV: 0.8 } }) as unknown as AnyBorrowVaultPair

  it('keeps a market with a vault the Lend table lists', () => {
    expect(isExploreListedMarket([evault('0xCollateralVault'), evault('0xLend')], [evPair('0xLend', '0xCollateralVault')], false)).toBe(true)
  })

  it('hides a market whose collateral vaults only back a lending vault hidden from Borrow (YieldNest)', () => {
    borrowHidden.add('0xSuspendedLend')
    lendHidden.add('0xSuspendedLend')
    const pairs = [evPair('0xSuspendedLend', '0xynUSDx'), evPair('0xSuspendedLend', '0xynRWAx')]
    expect(isExploreListedMarket([evault('0xynUSDx'), evault('0xynRWAx')], pairs, false)).toBe(false)
    expect(isExploreListedMarket([securitize('0xSecuritize')], pairs, false)).toBe(false)
  })

  it('keeps a collateral-only market whose vaults back another market\'s listed lending vault (Clearstar Yield)', () => {
    expect(isExploreListedMarket([evault('0xYieldCollateral')], [evPair('0xPrimeLend', '0xYieldCollateral')], false)).toBe(true)
  })

  it('keeps a market hidden from Lend that still has a Borrow-table pair (K3 BSC Stable)', () => {
    lendHidden.add('0xK3Usdc')
    lendHidden.add('0xK3Usde')
    expect(isExploreListedMarket([evault('0xK3Usdc'), evault('0xK3Usde')], [evPair('0xK3Usdc', '0xK3Usde')], false)).toBe(true)
  })

  it('hides a market whose only pair uses a collateral the Borrow table does not list', () => {
    unknown.add('0xUnlabeled')
    expect(isExploreListedMarket([evault('0xLend')], [evPair('0xLend', '0xUnlabeled')], false)).toBe(false)
  })

  it('keeps a fully deprecated market, which Explore lists last as before', () => {
    deprecated.add('0xOldLend')
    deprecated.add('0xOldCollateral')
    expect(isExploreListedMarket([evault('0xOldLend'), evault('0xOldCollateral')], [], false)).toBe(true)
    expect(isExploreListedMarket([evault('0xOldLend'), evault('0xLiveCollateral')], [], false)).toBe(false)
  })

  it('keeps every market when all label entries are shown', () => {
    expect(isExploreListedMarket([evault('0xCollateralVault')], [], true)).toBe(true)
  })
})
