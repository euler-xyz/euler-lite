import { describe, expect, it } from 'vitest'
import { __setEulerLabelsDataForTest } from '~/composables/useEulerLabels'
import {
  getActiveProductVaultAddresses,
  getUniqueEntitiesByVaults,
  isVaultGovernanceLimited,
  isVaultHighUtilisationWarningSuppressed,
  isVaultRecentlyAdded,
  normalizeProducts,
} from '~/utils/eulerLabelsUtils'
import { normalizeAddress } from '~/utils/normalizeAddress'

describe('normalizeProducts', () => {
  it('normalizes active and deprecated vault addresses', () => {
    const lowerAddress = '0x8d3f9f9eb2f5e8b48efbb4074440d1e2a34bc365'
    const deprecatedAddress = '0x0000000000000000000000000000000000000102'

    const { products } = normalizeProducts({
      test: {
        name: 'Test',
        description: '',
        entity: [],
        url: '',
        vaults: [lowerAddress],
        deprecatedVaults: [deprecatedAddress],
      },
    })

    expect(products.test.vaults).toEqual([normalizeAddress(lowerAddress)])
    expect(products.test.deprecatedVaults).toEqual([normalizeAddress(deprecatedAddress)])
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

describe('getUniqueEntitiesByVaults', () => {
  it('resolves each vault through its own governor in a multi-entity product', () => {
    const securitizeVault = normalizeAddress('0x0000000000000000000000000000000000001001')
    const borrowVault = normalizeAddress('0x0000000000000000000000000000000000001002')
    const securitizeGovernor = normalizeAddress('0x0000000000000000000000000000000000002001')
    const kpkGovernor = normalizeAddress('0x0000000000000000000000000000000000002002')

    __setEulerLabelsDataForTest({
      products: {
        test: {
          name: 'Test',
          description: '',
          entity: ['kpk', 'securitize'],
          url: '',
          vaults: [securitizeVault, borrowVault],
        },
      },
      entities: {
        kpk: {
          name: 'KPK',
          logo: 'kpk.svg',
          description: '',
          url: '',
          addresses: { [kpkGovernor]: 'KPK Safe' },
          social: {
            twitter: '',
            youtube: '',
            discord: '',
            telegram: '',
            github: '',
          },
        },
        securitize: {
          name: 'Securitize',
          logo: 'securitize.png',
          description: '',
          url: '',
          addresses: { [securitizeGovernor]: 'Securitize Governor' },
          social: {
            twitter: '',
            youtube: '',
            discord: '',
            telegram: '',
            github: '',
          },
        },
      },
    })

    expect(getUniqueEntitiesByVaults([
      { address: securitizeVault, governor: securitizeGovernor },
      { address: borrowVault, governorAdmin: kpkGovernor },
    ]).map(entity => entity.name)).toEqual(['Securitize', 'KPK'])
  })
})

describe('isVaultRecentlyAdded', () => {
  it('checks product recently-added tags', () => {
    const address = '0x0000000000000000000000000000000000000201'

    __setEulerLabelsDataForTest({
      products: {
        test: {
          name: 'Test',
          description: '',
          entity: [],
          url: '',
          vaults: [normalizeAddress(address)],
          tags: ['recently added'],
        },
      },
    })

    expect(isVaultRecentlyAdded(address)).toBe(true)
  })

  it('checks vault override recently-added tags', () => {
    const address = '0x0000000000000000000000000000000000000202'

    __setEulerLabelsDataForTest({
      products: {
        test: {
          name: 'Test',
          description: '',
          entity: [],
          url: '',
          vaults: [normalizeAddress(address)],
          vaultOverrides: {
            [normalizeAddress(address)]: {
              tags: ['recently added'],
            },
          },
        },
      },
    })

    expect(isVaultRecentlyAdded(address)).toBe(true)
  })

  it('checks Earn recently-added tags', () => {
    const lowerAddress = '0x8d3f9f9eb2f5e8b48efbb4074440d1e2a34bc365'
    const checksummedAddress = normalizeAddress(lowerAddress)

    __setEulerLabelsDataForTest({
      earnVaultEntries: {
        [lowerAddress]: {
          address: checksummedAddress,
          tags: ['recently added'],
        },
      },
    })

    expect(isVaultRecentlyAdded(checksummedAddress)).toBe(true)
  })
})

describe('isVaultGovernanceLimited', () => {
  it('checks governance-limited product tags', () => {
    const address = '0x0000000000000000000000000000000000000301'

    __setEulerLabelsDataForTest({
      products: {
        test: {
          name: 'Test',
          description: '',
          entity: [],
          url: '',
          vaults: [normalizeAddress(address)],
          tags: ['governance limited'],
        },
      },
    })

    expect(isVaultGovernanceLimited(address)).toBe(true)
  })
})

describe('isVaultHighUtilisationWarningSuppressed', () => {
  it('checks high-utilisation warning suppression product tags', () => {
    const address = '0x0000000000000000000000000000000000000401'

    __setEulerLabelsDataForTest({
      products: {
        test: {
          name: 'Test',
          description: '',
          entity: [],
          url: '',
          vaults: [normalizeAddress(address)],
          tags: ['suppress high utilisation warning'],
        },
      },
    })

    expect(isVaultHighUtilisationWarningSuppressed(address)).toBe(true)
  })

  it('checks high-utilisation warning suppression vault override tags', () => {
    const address = '0x0000000000000000000000000000000000000402'

    __setEulerLabelsDataForTest({
      products: {
        test: {
          name: 'Test',
          description: '',
          entity: [],
          url: '',
          vaults: [normalizeAddress(address)],
          vaultOverrides: {
            [normalizeAddress(address)]: {
              tags: ['suppress high utilisation warning'],
            },
          },
        },
      },
    })

    expect(isVaultHighUtilisationWarningSuppressed(address)).toBe(true)
  })
})
