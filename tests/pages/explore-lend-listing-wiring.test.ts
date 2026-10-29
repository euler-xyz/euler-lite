import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../..')
const source = (path: string) => readFileSync(resolve(root, path), 'utf8')

describe('Explore, Lend and Borrow share the table rules', () => {
  it('lists Lend vaults through isLendTableVault', () => {
    expect(source('pages/lend/index.vue')).toMatch(/isLendTableVault\(vault, borrowList\.value, showAllLabelEntries\.value\)/)
  })

  it('lists Borrow pairs through isBorrowTablePair', () => {
    expect(source('pages/borrow/index.vue')).toMatch(/isBorrowTablePair\(pair, showAllLabelEntries\.value\)/)
  })

  it('lists, filters and builds options from markets with a Lend-table vault or a Borrow-table pair', () => {
    const explore = source('pages/explore/index.vue')
    expect(explore).toMatch(/isExploreListedMarket\(group\.vaults, borrowList\.value, showAllLabelEntries\.value\)/)
    expect(explore).toMatch(/const filteredMarkets = computed\(\(\) => \{\n {2}return listedMarketGroups\.value/)
    expect(explore.match(/for \(const group of marketGroups\.value\)/g) ?? []).toHaveLength(0)
  })
})
