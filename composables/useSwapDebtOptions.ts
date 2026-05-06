import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import { useIntrinsicApy } from '~/composables/useIntrinsicApy'
import { useVaultRegistry } from '~/composables/useVaultRegistry'

import { buildCollateralOption, computeBorrowApy } from '~/utils/collateralOptions'
import { useReactiveMap } from '~/composables/useReactiveMap'

export const useSwapDebtOptions = ({
  collateralVault,
  currentBorrowVault,
}: {
  collateralVault: Ref<EVault | undefined>
  currentBorrowVault?: Ref<EVault | undefined>
}) => {
  const { getVerifiedEVaults } = useVaultRegistry()
  const { withIntrinsicBorrowApy, version: intrinsicVersion } = useIntrinsicApy()
  const { getBorrowRewardApy, version: rewardsVersion } = useRewardsApy()

  const borrowVaults = computed(() => {
    const collateral = collateralVault.value
    if (!collateral) {
      return []
    }

    const collateralAddress = getAddress(collateral.address)
    const currentBorrowAddress = currentBorrowVault?.value
      ? getAddress(currentBorrowVault.value.address)
      : null

    return getVerifiedEVaults().filter((vault) => {
      if (!vault.collaterals?.length) {
        return false
      }
      const hasCollateral = vault.collaterals.some(ltv =>
        getAddress(ltv.address) === collateralAddress && ltv.borrowLTV > 0,
      )
      if (!hasCollateral) {
        return false
      }
      if (currentBorrowAddress && getAddress(vault.address) === currentBorrowAddress) {
        return false
      }
      return vault.totalAssets > 0n && vault.caps.borrowCap > 0n && vault.availableLiquidity > 0n
    })
  })

  const borrowOptions = useReactiveMap(
    borrowVaults,
    [rewardsVersion, intrinsicVersion],
    async (vault) => {
      const apy = computeBorrowApy(vault, withIntrinsicBorrowApy, getBorrowRewardApy, collateralVault?.value?.address)
      return buildCollateralOption({ vault, type: 'vault', amount: 0, priceAmount: 0, apy, tagContext: 'swap-target', showBalance: false })
    },
  )

  return {
    borrowVaults,
    borrowOptions,
  }
}
