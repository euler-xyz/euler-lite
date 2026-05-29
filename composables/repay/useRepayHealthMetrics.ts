import type { EVault, PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import type { Ref, ComputedRef } from 'vue'

import { nanoToValue } from '~/utils/crypto-utils'
import { calculateRoe, computeNextLtv, computeNextHealth, computeLiquidationPrice } from '~/utils/repayUtils'

interface UseRepayHealthMetricsOptions {
  position: Ref<PortfolioBorrowPosition<VaultEntity> | undefined>
  borrowVault: ComputedRef<EVault | undefined>
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
