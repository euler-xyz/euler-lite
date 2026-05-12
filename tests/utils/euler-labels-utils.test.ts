import { describe, expect, it } from 'vitest'
import { normalizeProducts } from '~/utils/eulerLabelsUtils'
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
