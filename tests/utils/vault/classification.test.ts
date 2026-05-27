import { describe, it, expect } from 'vitest'
import type { EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { INTEREST_RATE_MODEL_TYPE } from '~/entities/constants'
import { isCyclicalNoteVault, isVaultBorrowable } from '~/utils/vault/classification'

const makeBorrowableInput = (
  isBorrowable: boolean,
  totalBorrowed: bigint,
): Pick<EVault, 'isBorrowable' | 'totalBorrowed'> =>
  ({ isBorrowable, totalBorrowed } as Pick<EVault, 'isBorrowable' | 'totalBorrowed'>)

describe('isVaultBorrowable', () => {
  it('is true when the SDK reports the vault as borrowable', () => {
    expect(isVaultBorrowable(makeBorrowableInput(true, 0n))).toBe(true)
  })

  it('is true on residual debt even when the SDK reports not borrowable', () => {
    expect(isVaultBorrowable(makeBorrowableInput(false, 1n))).toBe(true)
  })

  it('is false when not borrowable and there is no outstanding debt', () => {
    expect(isVaultBorrowable(makeBorrowableInput(false, 0n))).toBe(false)
  })
})

describe('isCyclicalNoteVault', () => {
  it('returns true for EVaults using the fixed cyclical IRM', () => {
    const vault = {
      interestRateModel: {
        type: INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY,
      },
    } as unknown as EVault

    expect(isCyclicalNoteVault(vault)).toBe(true)
  })

  it('returns true for EVaults using the monthly cyclical IRM', () => {
    const vault = {
      interestRateModel: {
        type: INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY_MONTHLY,
      },
    } as unknown as EVault

    expect(isCyclicalNoteVault(vault)).toBe(true)
  })

  it('returns false for non-cyclical EVaults', () => {
    const vault = {
      interestRateModel: {
        type: INTEREST_RATE_MODEL_TYPE.KINK,
      },
    } as unknown as EVault

    expect(isCyclicalNoteVault(vault)).toBe(false)
  })

  it('returns false for securitize vaults and missing vault data', () => {
    const securitizeVault = {
      type: 'securitize',
    } as SecuritizeCollateralVault

    expect(isCyclicalNoteVault(securitizeVault)).toBe(false)
    expect(isCyclicalNoteVault(null)).toBe(false)
    expect(isCyclicalNoteVault(undefined)).toBe(false)
  })

  it('returns false when the IRM type is missing or not numeric', () => {
    const missingType = {
      interestRateModel: {},
    } as unknown as EVault

    const stringType = {
      interestRateModel: {
        type: `${INTEREST_RATE_MODEL_TYPE.FIXED_CYCLICAL_BINARY}`,
      },
    } as unknown as EVault

    expect(isCyclicalNoteVault(missingType)).toBe(false)
    expect(isCyclicalNoteVault(stringType)).toBe(false)
  })
})
