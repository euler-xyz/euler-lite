import { beforeEach, describe, expect, it } from 'vitest'
import type { EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { getCollateralSupplyCapWarning, getUtilisationWarning } from '~/composables/useVaultWarnings'
import { __setEulerLabelsDataForTest } from '~/composables/useEulerLabels'
import { INTEREST_RATE_MODEL_TYPE } from '~/entities/constants'
import { normalizeAddress } from '~/utils/normalizeAddress'

const makeVault = (supplyCapUtilization: number): EVault =>
  ({
    caps: {
      supplyCapUtilization,
    },
  }) as EVault

const makeUtilisedVault = (
  totalAssets: bigint,
  borrow: bigint,
  interestRateModelType: number = INTEREST_RATE_MODEL_TYPE.KINK,
  address = '0x0000000000000000000000000000000000000001',
): EVault =>
  ({
    address: normalizeAddress(address),
    totalAssets,
    borrow,
    interestRateModel: { type: interestRateModelType },
  }) as unknown as EVault

describe('getUtilisationWarning', () => {
  beforeEach(() => {
    __setEulerLabelsDataForTest()
  })

  it('returns the standard high utilisation warning for non-cyclical borrow markets', () => {
    const warning = getUtilisationWarning(makeUtilisedVault(100n, 95n), 'borrow')

    expect(warning).toEqual({
      level: 'high',
      title: 'High utilisation',
      message: 'Utilisation is high on this market. Interest rates are elevated and may be volatile.',
    })
  })

  it.each(['borrow', 'lend', 'general'] as const)(
    'returns target utilisation info for highly utilised cyclical note markets in %s context',
    (context) => {
      const warning = getUtilisationWarning(
        makeUtilisedVault(100n, 99n, INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY),
        context,
      )

      expect(warning).toEqual({
        level: 'info',
        tone: 'success',
        title: 'Target utilisation',
        message: 'Cyclical Note markets are designed to run near full utilization. Withdrawal liquidity opens up at the end of each cycle, when borrowers are pushed to repay.',
      })
    },
  )

  it('keeps liquidity constraint copy for highly utilised cyclical repay sources', () => {
    const warning = getUtilisationWarning(
      makeUtilisedVault(100n, 99n, INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY),
      'repay',
    )

    expect(warning).toEqual({
      level: 'critical',
      title: 'Critical utilisation',
      message: 'Utilisation is critically high on this collateral market. Available liquidity is near zero, so repaying with collateral may fail.',
    })
  })

  it('does not show target utilisation info below the shared utilisation threshold', () => {
    const warning = getUtilisationWarning(
      makeUtilisedVault(100n, 94n, INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY),
      'borrow',
    )

    expect(warning).toBeNull()
  })

  it('suppresses high utilisation warnings for tagged vaults', () => {
    const address = normalizeAddress('0x0000000000000000000000000000000000000501')

    __setEulerLabelsDataForTest({
      products: {
        test: {
          name: 'Test',
          description: '',
          entity: [],
          url: '',
          vaults: [address],
          vaultOverrides: {
            [address]: {
              tags: ['suppress high utilisation warning'],
            },
          },
        },
      },
    })

    const warning = getUtilisationWarning(
      makeUtilisedVault(100n, 95n, INTEREST_RATE_MODEL_TYPE.KINK, address),
      'borrow',
    )

    expect(warning).toBeNull()
  })

  it('keeps critical utilisation warnings for tagged vaults', () => {
    const address = normalizeAddress('0x0000000000000000000000000000000000000502')

    __setEulerLabelsDataForTest({
      products: {
        test: {
          name: 'Test',
          description: '',
          entity: [],
          url: '',
          vaults: [address],
          tags: ['suppress high utilisation warning'],
        },
      },
    })

    const warning = getUtilisationWarning(
      makeUtilisedVault(100n, 99n, INTEREST_RATE_MODEL_TYPE.KINK, address),
      'borrow',
    )

    expect(warning).toEqual({
      level: 'critical',
      title: 'Critical utilisation',
      message: 'Utilisation is critically high. Interest rates are very elevated. Available liquidity is near zero.',
    })
  })
})

describe('getCollateralSupplyCapWarning', () => {
  it('returns collateral-specific copy when an EVK collateral supply cap is near its limit', () => {
    const warning = getCollateralSupplyCapWarning(makeVault(95))

    expect(warning).toEqual({
      level: 'info',
      title: 'Collateral supply cap approaching limit',
      message: 'The collateral supply cap is approaching its limit. Available capacity for new deposits is limited.',
    })
  })

  it('returns collateral-specific copy when an EVK collateral supply cap is reached', () => {
    const warning = getCollateralSupplyCapWarning(makeVault(100))

    expect(warning).toEqual({
      level: 'info',
      title: 'Collateral supply cap reached',
      message: 'The collateral supply cap has been reached. New deposits will fail.',
    })
  })

  it('does not warn for EVK collateral below the shared cap threshold', () => {
    expect(getCollateralSupplyCapWarning(makeVault(94))).toBeNull()
  })

  it('does not warn for Securitize collateral', () => {
    const securitizeVault = {
      type: 'securitize',
    } as SecuritizeCollateralVault

    expect(getCollateralSupplyCapWarning(securitizeVault)).toBeNull()
  })
})
