import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import { shouldIncludeWalletCollateral } from '~/utils/collateralFilters'

const PRIMARY = '0x1111111111111111111111111111111111111111' as Address
const SECONDARY = '0x2222222222222222222222222222222222222222' as Address

describe('shouldIncludeWalletCollateral', () => {
  it('keeps positive wallet balances', () => {
    expect(shouldIncludeWalletCollateral({
      balance: 1n,
      vaultAddress: SECONDARY,
      primaryCollateralAddress: PRIMARY,
    })).toBe(true)
  })

  it('keeps the primary collateral wallet option with a zero balance', () => {
    expect(shouldIncludeWalletCollateral({
      balance: 0n,
      vaultAddress: PRIMARY,
      primaryCollateralAddress: PRIMARY,
    })).toBe(true)
  })

  it('filters zero-balance non-primary wallet options', () => {
    expect(shouldIncludeWalletCollateral({
      balance: 0n,
      vaultAddress: SECONDARY,
      primaryCollateralAddress: PRIMARY,
    })).toBe(false)
  })
})
