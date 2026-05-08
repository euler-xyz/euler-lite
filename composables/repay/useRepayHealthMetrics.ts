import type { Ref, ComputedRef } from 'vue'
import type { AccountBorrowPosition } from '~/entities/account'
import { getProjectedRates, getRoe } from '~/entities/vault'
import { nanoToValue } from '~/utils/crypto-utils'
import { computeNextLtv, computeNextHealth, computeLiquidationPrice } from '~/utils/repayUtils'
import { createRaceGuard } from '~/utils/race-guard'

interface UseRepayHealthMetricsOptions {
  position: Ref<AccountBorrowPosition | undefined>
  borrowVault: ComputedRef<AccountBorrowPosition['borrow'] | undefined>
  debtRepaid: ComputedRef<bigint | null>
  priceRatio: ComputedRef<number | null>
  nextLiquidationLtv: ComputedRef<number | null>
  collateralAmountAfter: ComputedRef<number | null>
  collateralSupplyApy: ComputedRef<number | null>
  nextCollateralSupplyApy?: ComputedRef<number | null>
  borrowApy: ComputedRef<number | null>
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
    collateralValueUsd,
    nextCollateralValueUsd,
    borrowValueUsd,
    nextBorrowValueUsd,
  } = options

  const currentHealth = computed(() => {
    if (!position.value) return null
    return nanoToValue(position.value.health, 18)
  })

  const currentLtv = computed(() => {
    if (!position.value) return null
    return nanoToValue(position.value.userLTV, 18)
  })

  const currentLiquidationLtv = computed(() => {
    if (!position.value) return null
    return nanoToValue(position.value.liquidationLTV, 2)
  })

  const borrowAmountAfter = computed(() => {
    if (!borrowVault.value || !position.value || debtRepaid.value === null) return null
    const nextBorrow = position.value.borrowed - debtRepaid.value
    return nanoToValue(nextBorrow > 0n ? nextBorrow : 0n, borrowVault.value.decimals)
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
  const projectedBorrowApyGuard = createRaceGuard()

  watchEffect(async () => {
    const gen = projectedBorrowApyGuard.next()
    const vault = borrowVault.value
    const currentPosition = position.value
    const repaid = debtRepaid.value
    const currentBorrowApy = borrowApy.value

    if (!vault || !currentPosition || repaid === null) {
      projectedBorrowApy.value = null
      return
    }

    try {
      const repayAmount = repaid > currentPosition.borrowed
        ? currentPosition.borrowed
        : repaid

      const projected = await getProjectedRates(
        vault.address,
        vault.interestRateInfo.cash,
        vault.interestRateInfo.borrows,
        repayAmount,
        -repayAmount,
      )

      if (projectedBorrowApyGuard.isStale(gen)) return

      if (!projected) {
        projectedBorrowApy.value = null
        return
      }

      const currentRaw = nanoToValue(vault.interestRateInfo.borrowAPY || 0n, 25)
      const projectedRaw = nanoToValue(projected.borrowAPY, 25)
      projectedBorrowApy.value = (currentBorrowApy ?? 0) + (projectedRaw - currentRaw)
    }
    catch {
      if (!projectedBorrowApyGuard.isStale(gen)) {
        projectedBorrowApy.value = null
      }
    }
  })

  const roeBefore = computed(() =>
    getRoe(collateralValueUsd.value, collateralSupplyApy.value, borrowValueUsd.value, borrowApy.value))

  const roeAfter = computed(() =>
    getRoe(nextCollateralValueUsd.value, nextCollateralSupplyApy?.value ?? collateralSupplyApy.value, nextBorrowValueUsd.value, projectedBorrowApy.value ?? borrowApy.value))

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
  }
}
