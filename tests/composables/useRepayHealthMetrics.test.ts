import { computed, ref, shallowRef, watchEffect } from 'vue'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { EVault, PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { useRepayHealthMetrics } from '~/composables/repay/useRepayHealthMetrics'

const { getProjectedRates, getRoe } = vi.hoisted(() => ({
  getProjectedRates: vi.fn(async () => ({ supplyAPY: 0n, borrowAPY: 7n * 10n ** 25n })),
  getRoe: vi.fn(() => 0),
}))

vi.mock('~/utils/vault/apy', () => ({
  getProjectedRates,
  getPositionMultiplier: vi.fn(() => 2),
  getRoe,
}))

vi.mock('~/utils/vault-display', () => ({
  getVaultBorrowApy: vi.fn(() => 5),
}))

const VAULT = '0x0000000000000000000000000000000000000001'
const vault = {
  address: VAULT,
  totalCash: 100n,
  totalBorrowed: 100n,
  shares: { decimals: 18 },
} as unknown as EVault
const position = {
  borrowed: 100n,
  collateralVaults: [VAULT],
} as unknown as PortfolioBorrowPosition<VaultEntity>

const makeMetrics = (
  repayAddsCash?: boolean,
  collateralSnapshotComplete = true,
  nextCollateralSnapshotComplete = true,
  projectedBorrowRates?: { supplyAPY: bigint, borrowAPY: bigint },
) => useRepayHealthMetrics({
  position: shallowRef<PortfolioBorrowPosition<VaultEntity> | undefined>(position),
  borrowVault: computed(() => vault),
  debtRepaid: computed(() => 25n),
  priceRatio: computed(() => 1),
  nextLiquidationLtv: computed(() => 80),
  collateralAmountAfter: computed(() => 100),
  collateralSupplyApy: computed(() => 5),
  borrowApy: computed(() => 5),
  borrowRewardApy: computed(() => 0),
  collateralSnapshotComplete: ref(collateralSnapshotComplete),
  nextCollateralSnapshotComplete: ref(nextCollateralSnapshotComplete),
  projectedBorrowRates: projectedBorrowRates === undefined
    ? undefined
    : computed(() => projectedBorrowRates),
  repayAddsCash: repayAddsCash === undefined ? undefined : computed(() => repayAddsCash),
  collateralValueUsd: ref(100),
  nextCollateralValueUsd: ref(100),
  borrowValueUsd: ref(50),
  nextBorrowValueUsd: ref(25),
})

describe('useRepayHealthMetrics projected utilization', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('watchEffect', watchEffect)
    vi.stubGlobal('ltvToPercent', (value: number) => value)
    vi.stubGlobal('getBorrowPositionEffectiveLiquidationLTV', () => 0.8)
    vi.stubGlobal('useRewardsApy', () => ({
      getEligibleLoopingRewardApyForCollaterals: vi.fn(() => 0),
    }))
    vi.stubGlobal('useUserSettings', () => ({
      settings: ref({ enableIntrinsicApy: false }),
    }))
  })

  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })

  it('does not add cash when debt is repaid with same-vault shares', async () => {
    makeMetrics(false)

    await vi.waitFor(() => expect(getProjectedRates).toHaveBeenCalled())
    expect(getProjectedRates).toHaveBeenLastCalledWith(VAULT, 100n, 100n, 0n, -25n)
  })

  it('adds cash for an asset repayment', async () => {
    makeMetrics(true)

    await vi.waitFor(() => expect(getProjectedRates).toHaveBeenCalled())
    expect(getProjectedRates).toHaveBeenLastCalledWith(VAULT, 100n, 100n, 25n, -25n)
  })

  it('uses the unified collateral snapshot rate without issuing a second projection', async () => {
    const metrics = makeMetrics(undefined, true, true, {
      supplyAPY: 6n * 10n ** 25n,
      borrowAPY: 7n * 10n ** 25n,
    })

    await vi.waitFor(() => expect(metrics.roeAfter.value).toBe(0))
    expect(getProjectedRates).not.toHaveBeenCalled()
    expect(getRoe).toHaveBeenCalledWith(
      100,
      5,
      25,
      7,
      null,
      0,
      0,
    )
  })

  it('hides current and next ROE when their collateral snapshots are incomplete', () => {
    const currentIncomplete = makeMetrics(undefined, false, true)
    const nextIncomplete = makeMetrics(undefined, true, false)

    expect(currentIncomplete.roeBefore.value).toBeNull()
    expect(nextIncomplete.roeAfter.value).toBeNull()
  })

  it.each([
    ['returns null', () => getProjectedRates.mockResolvedValueOnce(null)],
    ['rejects', () => getProjectedRates.mockRejectedValueOnce(new Error('projection failed'))],
  ])('hides next ROE when the projected borrow rate %s', async (_label, arrange) => {
    arrange()
    const metrics = makeMetrics()

    await vi.waitFor(() => expect(getProjectedRates).toHaveBeenCalled())
    expect(metrics.roeAfter.value).toBeNull()
    expect(getRoe).not.toHaveBeenCalled()
  })
})
