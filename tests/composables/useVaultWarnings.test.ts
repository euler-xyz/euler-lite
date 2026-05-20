import { describe, expect, it } from 'vitest'
import { getCollateralSupplyCapWarning } from '~/composables/useVaultWarnings'
import type { SecuritizeVault, Vault } from '~/entities/vault'

const makeVault = (supply: bigint, supplyCap: bigint): Vault =>
  ({
    supply,
    supplyCap,
  }) as Vault

describe('getCollateralSupplyCapWarning', () => {
  it('returns collateral-specific copy when an EVK collateral supply cap is near its limit', () => {
    const warning = getCollateralSupplyCapWarning(makeVault(95n, 100n))

    expect(warning).toEqual({
      level: 'info',
      title: 'Collateral supply cap approaching limit',
      message: 'The collateral supply cap is approaching its limit. Available capacity for new deposits is limited.',
    })
  })

  it('returns collateral-specific copy when an EVK collateral supply cap is reached', () => {
    const warning = getCollateralSupplyCapWarning(makeVault(100n, 100n))

    expect(warning).toEqual({
      level: 'info',
      title: 'Collateral supply cap reached',
      message: 'The collateral supply cap has been reached. New deposits will fail.',
    })
  })

  it('does not warn for EVK collateral below the shared cap threshold', () => {
    expect(getCollateralSupplyCapWarning(makeVault(94n, 100n))).toBeNull()
  })

  it('does not warn for Securitize collateral', () => {
    const securitizeVault = {
      type: 'securitize',
      supply: 100n,
      supplyCap: 100n,
    } as SecuritizeVault

    expect(getCollateralSupplyCapWarning(securitizeVault)).toBeNull()
  })
})
