import type { EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import { useVaultRegistry } from '~/composables/useVaultRegistry'

import { buildCollateralOption, computeBorrowApy } from '~/utils/collateralOptions'
import { useReactiveMap } from '~/composables/useReactiveMap'
import { isOpDisabled, OP_BORROW } from '~/utils/vault-hooks'

export const useSwapDebtOptions = ({
  collateralVault,
  currentBorrowVault,
}: {
  collateralVault: Ref<EVault | SecuritizeCollateralVault | undefined>
  currentBorrowVault?: Ref<EVault | undefined>
}) => {
  const { getVerifiedEVaults } = useVaultRegistry()
  const { settings } = useUserSettings()
  const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
  const enableRewardsApy = computed(() => settings.value.enableRewardsApy)
  const { viewer } = useApyVisibility()

  const allBorrowVaults = computed(() => {
    const currentBorrowAddress = currentBorrowVault?.value
      ? getAddress(currentBorrowVault.value.address)
      : null

    return getVerifiedEVaults().filter((vault) => {
      if (currentBorrowAddress && getAddress(vault.address) === currentBorrowAddress) {
        return false
      }
      return vault.totalAssets > 0n
        && vault.caps.borrowCap > 0n
        && vault.availableLiquidity > 0n
        && !isOpDisabled(vault, OP_BORROW)
    })
  })

  const borrowVaults = computed(() => {
    const collateral = collateralVault.value
    if (!collateral) {
      return []
    }

    const collateralAddress = getAddress(collateral.address)

    return allBorrowVaults.value.filter((vault) => {
      if (!vault.collaterals?.length) {
        return false
      }
      return vault.collaterals.some(ltv =>
        getAddress(ltv.address) === collateralAddress && ltv.borrowLTV > 0,
      )
    })
  })

  const buildBorrowOption = async (vault: EVault) => {
    const apy = computeBorrowApy(
      vault,
      viewer.value,
      {
        enableIntrinsicApy: enableIntrinsicApy.value,
        enableRewardsApy: enableRewardsApy.value,
      },
      collateralVault?.value?.address,
    )
    return buildCollateralOption({ vault, type: 'vault', amount: 0, priceAmount: 0, apy, tagContext: 'swap-target', showBalance: false })
  }

  const borrowOptions = useReactiveMap(
    borrowVaults,
    [viewer, enableIntrinsicApy, enableRewardsApy],
    buildBorrowOption,
  )

  const allBorrowOptions = useReactiveMap(
    allBorrowVaults,
    [viewer, enableIntrinsicApy, enableRewardsApy, collateralVault],
    buildBorrowOption,
  )

  return {
    borrowVaults,
    borrowOptions,
    allBorrowVaults,
    allBorrowOptions,
  }
}
