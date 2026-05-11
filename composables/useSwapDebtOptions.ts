import { getAddress } from 'viem'
import { useIntrinsicApy } from '~/composables/useIntrinsicApy'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import type { Vault } from '~/entities/vault'
import { buildCollateralOption, computeBorrowApy } from '~/utils/collateralOptions'
import { useReactiveMap } from '~/composables/useReactiveMap'

export const useSwapDebtOptions = ({
  collateralVault,
  currentBorrowVault,
}: {
  collateralVault: Ref<Vault | undefined>
  currentBorrowVault?: Ref<Vault | undefined>
}) => {
  const { getVerifiedEvkVaults } = useVaultRegistry()
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

    return getVerifiedEvkVaults().filter((vault) => {
      if (!vault.collateralLTVs?.length) {
        return false
      }
      const hasCollateral = vault.collateralLTVs.some(ltv =>
        getAddress(ltv.collateral) === collateralAddress && ltv.borrowLTV > 0n,
      )
      if (!hasCollateral) {
        return false
      }
      if (currentBorrowAddress && getAddress(vault.address) === currentBorrowAddress) {
        return false
      }
      return vault.supply > 0n && vault.borrowCap > 0n && vault.totalCash > 0n
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
