import { describe, it, expect } from 'vitest'
import type { EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { INTEREST_RATE_MODEL_TYPE } from '~/entities/constants'
import { isBorrowPairPaused, isCyclicalNoteVault, isVaultBorrowable, isVaultBorrowPaused } from '~/utils/vault/classification'
import { NO_OPERATIONS_HOOKED, makeEbold1, makeEsbold1, makeEusdc42 } from '~/tests/fixtures/liquity-hub'

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

describe('a paused vault (K3 Liquity Hub)', () => {
  const live = { hookedOperations: NO_OPERATIONS_HOOKED }

  it('is not borrowable while borrow is hooked with a zero target', () => {
    expect(isVaultBorrowPaused(makeEusdc42())).toBe(true)
    expect(isVaultBorrowPaused(makeEusdc42(live))).toBe(false)
  })

  it('treats only the borrow hook, or the status check, as blocking a new borrow', () => {
    expect(isVaultBorrowPaused(makeEusdc42({ hookedOperations: { ...NO_OPERATIONS_HOOKED, borrow: true } }))).toBe(true)
    expect(isVaultBorrowPaused(makeEusdc42({ hookedOperations: { ...NO_OPERATIONS_HOOKED, vaultStatusCheck: true } }))).toBe(true)
    expect(isVaultBorrowPaused(makeEusdc42({ hookedOperations: { ...NO_OPERATIONS_HOOKED, deposit: true } }))).toBe(false)
    expect(isVaultBorrowPaused(makeEusdc42({
      hookedOperations: { ...NO_OPERATIONS_HOOKED, borrow: true },
      hookTarget: '0x00000000000000000000000000000000000000aa',
    }))).toBe(false)
  })

  it('keeps its borrow side, so outstanding debt and exposure stay visible', () => {
    expect(isVaultBorrowable(makeEusdc42())).toBe(true)
  })

  it('pauses a pair when the liability cannot lend or the collateral cannot take a deposit', () => {
    expect(isBorrowPairPaused(makeEbold1(), makeEsbold1())).toBe(true)
    expect(isBorrowPairPaused(makeEbold1(live), makeEsbold1())).toBe(true)
    expect(isBorrowPairPaused(makeEbold1(), makeEsbold1(live))).toBe(true)
    expect(isBorrowPairPaused(makeEbold1(live), makeEsbold1(live))).toBe(false)
    expect(isBorrowPairPaused(makeEbold1(live), { type: 'SecuritizeCollateral' })).toBe(false)
  })
})
