import { describe, expect, it } from 'vitest'
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { useVaultSearch } from '~/composables/useVaultSearch'
import { getBorrowPairSearchAddresses } from '~/utils/borrow-pair'

const makeBorrowPair = (): AnyBorrowVaultPair => ({
  collateral: {
    address: '0x1905EDDF5943ef6C92Ccf1469bd40fC2cB4A77b0',
    asset: {
      address: '0x2222222222222222222222222222222222222222',
      name: 'Collateral Token',
      symbol: 'COL',
    },
  },
  borrow: {
    address: '0x3333333333333333333333333333333333333333',
    asset: {
      address: '0x4444444444444444444444444444444444444444',
      name: 'Borrow Token',
      symbol: 'BOR',
    },
  },
  ltv: {},
}) as unknown as AnyBorrowVaultPair

describe('useVaultSearch', () => {
  it('matches borrow pairs by vault and token addresses', () => {
    const pair = makeBorrowPair()
    const { searchQuery, matchesSearch } = useVaultSearch<AnyBorrowVaultPair>(item => [
      item.collateral.asset.symbol,
      item.borrow.asset.symbol,
      ...getBorrowPairSearchAddresses(item),
    ])

    searchQuery.value = '0x1905eddf5943ef6c92ccf1469bd40fc2cb4a77b0'
    expect(matchesSearch(pair)).toBe(true)

    searchQuery.value = '0x4444444444444444444444444444444444444444'
    expect(matchesSearch(pair)).toBe(true)
  })
})
