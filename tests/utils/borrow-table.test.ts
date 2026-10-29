import { describe, expect, it, vi } from 'vitest'
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { hasBorrowTablePair, isBorrowTableCollateral } from '~/utils/vault/borrow-table'

const borrowHidden = vi.hoisted(() => new Set<string>())
const unknown = vi.hoisted(() => new Set<string>())

vi.mock('~/utils/eulerLabelsUtils', () => ({
  isVaultNotExplorableBorrow: (address: string) => borrowHidden.has(address),
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
