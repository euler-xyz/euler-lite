import { describe, expect, it } from 'vitest'
import {
  getFreeSubAccounts,
  getSubAccountAddress,
  isBorrowControllerCompatible,
  selectBorrowCompatibleSubAccount,
} from '~/entities/account'

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
