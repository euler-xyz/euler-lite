import { describe, expect, it } from 'vitest'
import type { Address } from 'viem'
import type { EVault, PortfolioBorrowPosition, PortfolioSavingsPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { buildCrossPositionRepayCollateralCandidates } from '~/composables/useCrossPositionRepayCollateralOptions'

const TARGET_ACCOUNT = '0x0000000000000000000000000000000000000001' as Address
const SOURCE_ACCOUNT = '0x0000000000000000000000000000000000000002' as Address
const OTHER_ACCOUNT = '0x0000000000000000000000000000000000000003' as Address
const LIABILITY_VAULT = '0x0000000000000000000000000000000000000010' as Address
const OTHER_VAULT = '0x0000000000000000000000000000000000000020' as Address

const liabilityVault = {
  address: LIABILITY_VAULT,
  asset: { address: '0x0000000000000000000000000000000000000030', symbol: 'USDC', decimals: 6 },
  shares: { address: LIABILITY_VAULT, symbol: 'eUSDC', decimals: 6 },
  collaterals: [],
} as unknown as EVault

const position = (
  subAccount: Address,
  collaterals: Array<{ vaultAddress: Address, assets: bigint, shares: bigint }>,
) => ({ subAccount, collaterals }) as unknown as PortfolioBorrowPosition<VaultEntity>

describe('buildCrossPositionRepayCollateralCandidates', () => {
  const target = position(TARGET_ACCOUNT, [{ vaultAddress: OTHER_VAULT, assets: 10n, shares: 10n }])
  const exactVaultSource = position(SOURCE_ACCOUNT, [{ vaultAddress: LIABILITY_VAULT, assets: 25n, shares: 24n }])
  const crossVaultSource = position(OTHER_ACCOUNT, [{ vaultAddress: OTHER_VAULT, assets: 30n, shares: 30n }])

  it('exposes only positive exact-vault collateral from other positions when enabled', () => {
    const result = buildCrossPositionRepayCollateralCandidates({
      positions: [target, exactVaultSource, crossVaultSource],
      targetPosition: target,
      liabilityVault,
      enabled: true,
    })

    expect(result).toEqual([expect.objectContaining({
      id: `${SOURCE_ACCOUNT.toLowerCase()}:${LIABILITY_VAULT.toLowerCase()}`,
      vault: liabilityVault,
      sourceAccount: SOURCE_ACCOUNT,
      assets: 25n,
      shares: 24n,
    })])
  })

  it('does not expose cross-position collateral outside advanced mode', () => {
    expect(buildCrossPositionRepayCollateralCandidates({
      positions: [target, exactVaultSource],
      targetPosition: target,
      liabilityVault,
      enabled: false,
    })).toEqual([])
  })

  it('excludes zero balances and deduplicates the same vault position', () => {
    const empty = position(OTHER_ACCOUNT, [{ vaultAddress: LIABILITY_VAULT, assets: 0n, shares: 1n }])
    const result = buildCrossPositionRepayCollateralCandidates({
      positions: [target, exactVaultSource, exactVaultSource, empty],
      targetPosition: target,
      liabilityVault,
      enabled: true,
    })

    expect(result).toHaveLength(1)
    expect(result[0]?.sourceAccount).toBe(SOURCE_ACCOUNT)
  })

  it('retains collateral-enabled savings projected after the reciprocal debt is repaid', () => {
    const projectedSaving = {
      subAccount: SOURCE_ACCOUNT,
      assets: 20n,
      shares: 19n,
      position: {
        vaultAddress: LIABILITY_VAULT,
        isCollateral: true,
      },
    } as unknown as PortfolioSavingsPosition<VaultEntity>

    const result = buildCrossPositionRepayCollateralCandidates({
      positions: [target],
      savingsPositions: [projectedSaving],
      targetPosition: target,
      liabilityVault,
      enabled: true,
    })

    expect(result).toEqual([expect.objectContaining({
      sourceAccount: SOURCE_ACCOUNT,
      assets: 20n,
      shares: 19n,
    })])
  })
})
