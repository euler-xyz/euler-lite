import type { Ref, ComputedRef } from 'vue'
import type { AccountBorrowPosition } from '~/entities/account'
import { nanoToValue } from '~/utils/crypto-utils'
import { calculateRoe, computeNextLtv, computeNextHealth, computeLiquidationPrice } from '~/utils/repayUtils'

interface UseRepayHealthMetricsOptions {
  position: Ref<AccountBorrowPosition | undefined>
  borrowVault: ComputedRef<AccountBorrowPosition['borrow'] | undefined>
  debtRepaid: ComputedRef<bigint | null>
  priceRatio: ComputedRef<number | null>
  nextLiquidationLtv: ComputedRef<number | null>
  collateralAmountAfter: ComputedRef<number | null>
  collateralSupplyApy: ComputedRef<number | null>
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
    return ltvToPercent(position.value.liquidationLTV)
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

  const roeBefore = computed(() =>
    calculateRoe(collateralValueUsd.value, borrowValueUsd.value, collateralSupplyApy.value, borrowApy.value))

  const roeAfter = computed(() =>
    calculateRoe(nextCollateralValueUsd.value, nextBorrowValueUsd.value, collateralSupplyApy.value, borrowApy.value))

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
