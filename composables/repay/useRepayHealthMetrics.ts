import type { EVault, PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import type { Ref, ComputedRef } from 'vue'
import { getPositionMultiplier, getProjectedRates, getRoe } from '~/utils/vault/apy'
import { getVaultBorrowApy } from '~/utils/vault-display'
import { nanoToValue } from '~/utils/crypto-utils'
import { withProjectedVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import { computeNextLtv, computeNextHealth, computeLiquidationPrice } from '~/utils/repayUtils'
import { createRaceGuard } from '~/utils/race-guard'
import type { CollateralApySnapshot } from '~/composables/usePositionCollateralApy'
import {
  getCollateralSnapshotCampaignInputs,
  getCollateralSnapshotRateLines,
  getProjectedYieldStateFromCollateralSnapshot,
  mergeProjectedRewardCampaigns,
  type ProjectedYieldCampaignInput,
  type ProjectedYieldDetails,
} from '~/utils/projected-yield'

interface UseRepayHealthMetricsOptions {
  position: Ref<PortfolioBorrowPosition<VaultEntity> | undefined>
  borrowVault: ComputedRef<EVault | undefined>
  debtRepaid: ComputedRef<bigint | null>
  priceRatio: ComputedRef<number | null>
  nextLiquidationLtv: ComputedRef<number | null>
  collateralAmountAfter: ComputedRef<number | null>
  collateralSupplyApy: ComputedRef<number | null>
  nextCollateralSupplyApy?: ComputedRef<number | null>
  borrowApy: ComputedRef<number | null>
  borrowRewardApy: ComputedRef<number | null>
  nextBorrowRewardApy?: ComputedRef<number | null>
  collateralSnapshotComplete: Ref<boolean>
  nextCollateralSnapshotComplete: Ref<boolean>
  collateralAddresses?: Ref<readonly string[]>
  nextCollateralAddresses?: Ref<readonly string[]>
  collateralSnapshot?: Ref<CollateralApySnapshot | null>
  nextCollateralSnapshot?: Ref<CollateralApySnapshot | null>
  repayAddsCash?: ComputedRef<boolean>
  collateralValueUsd: Ref<number | null>
  nextCollateralValueUsd: Ref<number | null>
  borrowValueUsd: Ref<number | null>
  nextBorrowValueUsd: Ref<number | null>
}

export const useRepayHealthMetrics = (options: UseRepayHealthMetricsOptions) => {
  const {
    position,
    borrowVault,
    debtRepaid,
    priceRatio,
    nextLiquidationLtv,
    collateralAmountAfter,
    collateralSupplyApy,
    nextCollateralSupplyApy,
    borrowApy,
    borrowRewardApy,
    nextBorrowRewardApy,
    collateralSnapshotComplete,
    nextCollateralSnapshotComplete,
    collateralAddresses,
    nextCollateralAddresses,
    collateralSnapshot,
    nextCollateralSnapshot,
    repayAddsCash,
    collateralValueUsd,
    nextCollateralValueUsd,
    borrowValueUsd,
    nextBorrowValueUsd,
  } = options
  const {
    getEligibleLoopingRewardApyForCollaterals,
    getBorrowRewardCampaignsForCollaterals,
    getEligibleLoopingRewardCampaignsForCollaterals,
  } = useRewardsApy()
  const { settings } = useUserSettings()
  const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)

  const currentHealth = computed(() => {
    if (!position.value) return null
    const health = position.value.healthFactor
    return health === undefined ? null : nanoToValue(health, 18)
  })

  const currentLtv = computed(() => {
    if (!position.value) return null
    const ltv = position.value.userLTV ?? position.value.currentLTV
    return ltv === undefined ? null : ltvToPercent(nanoToValue(ltv, 18))
  })

  const currentLiquidationLtv = computed(() => {
    if (!position.value) return null
    const liquidationLTV = getBorrowPositionEffectiveLiquidationLTV(position.value)
    return liquidationLTV === undefined ? null : ltvToPercent(liquidationLTV)
  })

  const borrowAmountAfter = computed(() => {
    if (!borrowVault.value || !position.value || debtRepaid.value === null) return null
    const nextBorrow = position.value.borrowed - debtRepaid.value
    return nanoToValue(nextBorrow > 0n ? nextBorrow : 0n, borrowVault.value.shares.decimals)
  })

  const nextLtv = computed(() => {
    if (borrowAmountAfter.value === null || collateralAmountAfter.value === null || !priceRatio.value) return null
    return computeNextLtv(borrowAmountAfter.value, collateralAmountAfter.value, priceRatio.value)
  })

  const nextHealth = computed(() =>
    computeNextHealth(nextLiquidationLtv.value, nextLtv.value))

  const currentLiquidationPrice = computed(() =>
    computeLiquidationPrice(priceRatio.value, currentHealth.value))

  const nextLiquidationPrice = computed(() =>
    computeLiquidationPrice(priceRatio.value, nextHealth.value))

  const projectedBorrowApy = ref<number | null>(null)
  const projectedBorrowRawApy = ref<number | null>(null)
  const projectedBorrowApyComplete = ref(false)
  const projectedBorrowApyGuard = createRaceGuard()

  watchEffect(async () => {
    const gen = projectedBorrowApyGuard.next()
    const vault = borrowVault.value
    const currentPosition = position.value
    const repaid = debtRepaid.value
    void borrowApy.value
    projectedBorrowApyComplete.value = false

    if (!vault || !currentPosition || repaid === null) {
      projectedBorrowApy.value = null
      projectedBorrowRawApy.value = null
      return
    }

    try {
      const repayAmount = repaid > currentPosition.borrowed
        ? currentPosition.borrowed
        : repaid

      const projected = await getProjectedRates(
        vault.address,
        vault.totalCash,
        vault.totalBorrowed,
        repayAddsCash?.value === false ? 0n : repayAmount,
        -repayAmount,
      )

      if (projectedBorrowApyGuard.isStale(gen)) return

      if (!projected) {
        projectedBorrowApy.value = null
        projectedBorrowRawApy.value = null
        return
      }

      const currentRaw = getVaultBorrowApy(vault)
      const projectedRaw = nanoToValue(projected.borrowAPY, 25)
      projectedBorrowApy.value = withProjectedVaultIntrinsicApy(
        currentRaw,
        projectedRaw,
        vault,
        enableIntrinsicApy.value,
      )
      projectedBorrowRawApy.value = projectedRaw
      projectedBorrowApyComplete.value = true
    }
    catch {
      if (!projectedBorrowApyGuard.isStale(gen)) {
        projectedBorrowApy.value = null
        projectedBorrowRawApy.value = null
      }
    }
  })

  const getLoopingRewardApy = (
    supplyUsd: number | null,
    borrowUsd: number | null,
    addresses: readonly string[] | undefined,
  ) => {
    const vault = borrowVault.value
    if (!vault || !position.value) return 0
    return getEligibleLoopingRewardApyForCollaterals(
      vault.address,
      addresses ?? position.value.collateralVaults ?? [],
      getPositionMultiplier(supplyUsd, borrowUsd),
    )
  }

  const currentRoeState = computed(() => {
    const snapshot = collateralSnapshot?.value
    const vault = borrowVault.value
    const currentBorrowUsd = borrowValueUsd.value
    const currentBorrowApy = borrowApy.value
    if (!snapshot || !vault || currentBorrowUsd === null || currentBorrowApy === null) return null
    return getProjectedYieldStateFromCollateralSnapshot('roe', snapshot, {
      borrowUsd: currentBorrowUsd,
      baseBorrowApy: getVaultBorrowApy(vault),
      borrowApyWithIntrinsic: currentBorrowApy,
      borrowRewardApy: borrowRewardApy.value,
      loopingRewardApy: getLoopingRewardApy(
        snapshot.supplyUsd,
        currentBorrowUsd,
        snapshot.collateralAddresses,
      ),
    })
  })

  const nextRoeState = computed(() => {
    const snapshot = nextCollateralSnapshot?.value
    const projectedBorrowUsd = nextBorrowValueUsd.value
    const nextBorrowApy = projectedBorrowApy.value
    const nextBorrowRaw = projectedBorrowRawApy.value
    if (
      !snapshot
      || projectedBorrowUsd === null
      || nextBorrowApy === null
      || nextBorrowRaw === null
      || !projectedBorrowApyComplete.value
    ) return null
    return getProjectedYieldStateFromCollateralSnapshot('roe', snapshot, {
      borrowUsd: projectedBorrowUsd,
      baseBorrowApy: nextBorrowRaw,
      borrowApyWithIntrinsic: nextBorrowApy,
      borrowRewardApy: nextBorrowRewardApy?.value ?? borrowRewardApy.value,
      loopingRewardApy: getLoopingRewardApy(
        snapshot.supplyUsd,
        projectedBorrowUsd,
        snapshot.collateralAddresses,
      ),
    })
  })

  const roeBefore = computed(() => {
    if (!collateralSnapshotComplete.value) return null
    if (collateralSnapshot) return currentRoeState.value?.total ?? null
    return getRoe(
      collateralValueUsd.value,
      collateralSupplyApy.value,
      borrowValueUsd.value,
      borrowApy.value,
      null,
      borrowRewardApy.value,
      getLoopingRewardApy(collateralValueUsd.value, borrowValueUsd.value, collateralAddresses?.value),
    )
  })

  const roeAfter = computed(() => {
    if (
      !nextCollateralSnapshotComplete.value
      || !projectedBorrowApyComplete.value
      || projectedBorrowApy.value === null
    ) return null
    if (nextCollateralSnapshot) return nextRoeState.value?.total ?? null
    return getRoe(
      nextCollateralValueUsd.value,
      nextCollateralSupplyApy?.value ?? collateralSupplyApy.value,
      nextBorrowValueUsd.value,
      projectedBorrowApy.value,
      null,
      nextBorrowRewardApy?.value ?? borrowRewardApy.value,
      getLoopingRewardApy(nextCollateralValueUsd.value, nextBorrowValueUsd.value, nextCollateralAddresses?.value),
    )
  })

  const buildCampaignInputs = (
    snapshot: CollateralApySnapshot,
    supplyUsd: number | null,
    debtUsd: number | null,
  ): ProjectedYieldCampaignInput[] => {
    const vault = borrowVault.value
    if (!vault) return []
    const addresses = snapshot.collateralAddresses
    const multiplier = getPositionMultiplier(supplyUsd, debtUsd)
    return [
      ...getCollateralSnapshotCampaignInputs(snapshot),
      ...(debtUsd !== null && debtUsd > 0
        ? getBorrowRewardCampaignsForCollaterals(vault.address, addresses)
            .map(campaign => ({ campaign, vaultAddress: vault.address }))
        : []),
      ...getEligibleLoopingRewardCampaignsForCollaterals(vault.address, addresses, multiplier)
        .map(campaign => ({ campaign, vaultAddress: vault.address })),
    ]
  }

  const projectedYieldDetails = computed<ProjectedYieldDetails | null>(() => {
    const currentSnapshot = collateralSnapshot?.value
    const nextSnapshot = nextCollateralSnapshot?.value
    const vault = borrowVault.value
    const currentBorrowUsd = borrowValueUsd.value
    const projectedBorrowUsd = nextBorrowValueUsd.value
    const currentBorrowApy = borrowApy.value
    const nextBorrowApy = projectedBorrowApy.value
    const nextBorrowRaw = projectedBorrowRawApy.value
    if (
      !currentSnapshot
      || !nextSnapshot
      || !vault
      || currentBorrowUsd === null
      || projectedBorrowUsd === null
      || currentBorrowApy === null
      || nextBorrowApy === null
      || nextBorrowRaw === null
      || !projectedBorrowApyComplete.value
    ) return null

    const currentRaw = getVaultBorrowApy(vault)
    const before = currentRoeState.value
    const after = nextRoeState.value
    if (!after) return null

    return {
      metric: 'roe',
      before,
      after,
      rateLines: [
        ...getCollateralSnapshotRateLines(currentSnapshot, nextSnapshot),
        {
          id: `borrow:${vault.address.toLowerCase()}`,
          label: 'Borrow APY',
          symbol: vault.asset.symbol,
          vaultAddress: vault.address,
          before: currentRaw,
          after: nextBorrowRaw,
        },
      ],
      rewards: mergeProjectedRewardCampaigns(
        buildCampaignInputs(currentSnapshot, currentSnapshot.supplyUsd, currentBorrowUsd),
        buildCampaignInputs(nextSnapshot, nextSnapshot.supplyUsd, projectedBorrowUsd),
      ),
    }
  })

  return {
    currentHealth,
    currentLtv,
    currentLiquidationLtv,
    borrowAmountAfter,
    nextLtv,
    nextHealth,
    currentLiquidationPrice,
    nextLiquidationPrice,
    roeBefore,
    roeAfter,
    projectedYieldDetails,
  }
}
