import { describe, expect, it } from 'vitest'
import type { EVault, EulerEarn, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { getCashLimitedWithdrawAmount } from '~/utils/vault/withdraw'

describe('getCashLimitedWithdrawAmount', () => {
  const eVault = (availableLiquidity: bigint) => ({ type: 'EVault', availableLiquidity } as EVault)
  const securitizeVault = (totalAssets: bigint) =>
    ({ type: 'SecuritizeCollateral', totalAssets } as SecuritizeCollateralVault)
  const earnVault = (availableAssets: bigint) =>
    ({ type: 'EulerEarn', availableAssets } as EulerEarn)

  it('returns the user withdrawable amount when EVault liquidity is higher', () => {
    expect(getCashLimitedWithdrawAmount(1_000n, eVault(2_000n))).toBe(1_000n)
  })

  it('caps the amount to EVault available liquidity when liquidity is lower', () => {
    expect(getCashLimitedWithdrawAmount(2_000n, eVault(1_000n))).toBe(1_000n)
  })

  it('returns the user amount when the vault is undefined', () => {
    expect(getCashLimitedWithdrawAmount(2_000n, undefined)).toBe(2_000n)
  })

  it('caps SecuritizeCollateralVault by totalAssets', () => {
    expect(getCashLimitedWithdrawAmount(2_000n, securitizeVault(1_000n))).toBe(1_000n)
    expect(getCashLimitedWithdrawAmount(500n, securitizeVault(1_000n))).toBe(500n)
  })

  it('caps EulerEarn by availableAssets', () => {
    expect(getCashLimitedWithdrawAmount(2_000n, earnVault(1_000n))).toBe(1_000n)
    expect(getCashLimitedWithdrawAmount(500n, earnVault(1_000n))).toBe(500n)
  })
})
