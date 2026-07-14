import type {
  EVault,
  PortfolioBorrowPosition,
  SecuritizeCollateralVault,
  VaultEntity,
} from '@eulerxyz/euler-v2-sdk'
import { getNetAPYFromWeightedSupplySnapshot, getPositionMultiplier } from '~/utils/vault/apy'
import { getAssetUsdValueForEstimate } from '~/utils/sdk-prices'
import { getVaultBorrowApy, getVaultSupplyApy } from '~/utils/vault-display'
import { withVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import { createRaceGuard } from '~/utils/race-guard'
import { logWarn } from '~/utils/errorHandling'

interface UseRepayNetApyOptions {
  position: Ref<PortfolioBorrowPosition<VaultEntity> | undefined>
  borrowVault: Ref<EVault | undefined>
  collateralVault: Ref<EVault | SecuritizeCollateralVault | undefined>
}

export const useRepayNetApy = ({
  position,
  borrowVault,
  collateralVault,
}: UseRepayNetApyOptions) => {
  const {
    version: rewardsVersion,
    getSupplyRewardApy,
    getBorrowRewardApyForCollaterals,
    getEligibleLoopingRewardApyForCollaterals,
  } = useRewardsApy()
  const { getCollateralApySnapshot } = usePositionCollateralApy()
  const { settings } = useUserSettings()
  const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)

  const collateralSupplyRewardApy = computed(() => {
    void rewardsVersion.value
    return getSupplyRewardApy(collateralVault.value?.address || '')
  })
  const borrowRewardApy = computed(() => {
    void rewardsVersion.value
    return getBorrowRewardApyForCollaterals(
      borrowVault.value?.address || '',
      position.value?.collateralVaults ?? [],
    )
  })
  const collateralSupplyApy = computed(() => withVaultIntrinsicApy(
    getVaultSupplyApy(collateralVault.value),
    collateralVault.value,
    enableIntrinsicApy.value,
  ))
  const borrowApy = computed(() => withVaultIntrinsicApy(
    getVaultBorrowApy(borrowVault.value),
    borrowVault.value,
    enableIntrinsicApy.value,
  ))

  const guard = createRaceGuard()
  const netAPY = ref<number | null>(null)
  watchEffect(async () => {
    const gen = guard.next()
    netAPY.value = null
    void rewardsVersion.value
    const currentPosition = position.value
    const currentCollateralVault = collateralVault.value
    const currentBorrowVault = borrowVault.value
    const currentCollateralSupplyApy = collateralSupplyApy.value
    const currentBorrowApy = borrowApy.value
    const currentCollateralSupplyRewardApy = collateralSupplyRewardApy.value
    const currentBorrowRewardApy = borrowRewardApy.value

    if (!currentPosition || !currentCollateralVault || !currentBorrowVault) return

    try {
      const [collateralSnapshot, borrowUsd] = await Promise.all([
        getCollateralApySnapshot(currentPosition, currentBorrowVault),
        getAssetUsdValueForEstimate(currentPosition.borrowed ?? 0n, currentBorrowVault, 'off-chain'),
      ])
      if (guard.isStale(gen)) return
      if (borrowUsd === undefined) return
      const loopingRewardApy = getEligibleLoopingRewardApyForCollaterals(
        currentBorrowVault.address,
        collateralSnapshot.collateralAddresses ?? currentPosition.collateralVaults ?? [],
        getPositionMultiplier(collateralSnapshot.supplyUsd, borrowUsd),
      )
      netAPY.value = getNetAPYFromWeightedSupplySnapshot(
        collateralSnapshot,
        currentCollateralSupplyApy,
        borrowUsd,
        currentBorrowApy,
        currentCollateralSupplyRewardApy || null,
        currentBorrowRewardApy || null,
        loopingRewardApy || null,
      )
    }
    catch (error) {
      if (guard.isStale(gen)) return
      netAPY.value = null
      logWarn('repay/currentNetApy', error)
    }
  })

  return {
    netAPY,
    collateralSupplyApy,
    borrowApy,
    collateralSupplyRewardApy,
    borrowRewardApy,
  }
}
