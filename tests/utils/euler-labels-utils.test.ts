import { describe, expect, it } from 'vitest'
import { __setEulerLabelsDataForTest } from '~/composables/useEulerLabels'
import { getActiveProductVaultAddresses, isVaultRecentlyAdded, normalizeProducts } from '~/utils/eulerLabelsUtils'
import { normalizeAddress } from '~/utils/normalizeAddress'

describe('normalizeProducts', () => {
  it('normalizes recently added vault addresses for membership checks', () => {
    const lowerAddress = '0x8d3f9f9eb2f5e8b48efbb4074440d1e2a34bc365'

    const { products } = normalizeProducts({
      test: {
        name: 'Test',
        description: '',
        entity: [],
        url: '',
        vaults: [lowerAddress],
        recentlyAddedVaults: [lowerAddress],
      },
    })

    expect(products.test.recentlyAddedVaults).toEqual([normalizeAddress(lowerAddress)])
  })
})

describe('getActiveProductVaultAddresses', () => {
  it('returns active product vaults without deprecated-only entries', () => {
    const active = '0x0000000000000000000000000000000000000101'
    const deprecated = '0x0000000000000000000000000000000000000102'

    __setEulerLabelsDataForTest({
      products: {
        test: {
          name: 'Test',
          description: '',
          entity: [],
          url: '',
          vaults: [normalizeAddress(active)],
          deprecatedVaults: [normalizeAddress(deprecated)],
        },
      },
      verifiedVaultAddresses: [normalizeAddress(active), normalizeAddress(deprecated)],
    })

    expect(getActiveProductVaultAddresses()).toEqual([normalizeAddress(active)])
  })
})

describe('isVaultRecentlyAdded', () => {
  it('checks product recently-added vaults', () => {
    const address = '0x0000000000000000000000000000000000000201'

    __setEulerLabelsDataForTest({
      products: {
        test: {
          name: 'Test',
          description: '',
          entity: [],
          url: '',
          vaults: [normalizeAddress(address)],
          recentlyAddedVaults: [normalizeAddress(address)],
        },
      },
    })

    expect(isVaultRecentlyAdded(address)).toBe(true)
  })

  it('checks SDK Earn recently-added vaults', () => {
    const address = '0x0000000000000000000000000000000000000202'

    __setEulerLabelsDataForTest({
      recentlyAddedEarnVaults: new Set([normalizeAddress(address)]),
    })

    expect(isVaultRecentlyAdded(address.toLowerCase())).toBe(true)
  })
})
