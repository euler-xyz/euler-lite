import type { EVault, SecuritizeCollateralVault } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import { useVaultRegistry } from '~/composables/useVaultRegistry'

import { buildCollateralOption, computeBorrowApy } from '~/utils/collateralOptions'
import { useReactiveMap } from '~/composables/useReactiveMap'
import { isOpDisabled, OP_BORROW } from '~/utils/vault-hooks'
import { activeLayerVaultsRef, getLayeredVault } from '~/composables/useLayeredVaults'

export const useSwapDebtOptions = ({
  collateralVault,
  collateralAddresses,
  currentBorrowVault,
}: {
  collateralVault: Ref<EVault | SecuritizeCollateralVault | undefined>
  collateralAddresses?: Readonly<Ref<readonly string[]>>
  currentBorrowVault?: Ref<EVault | undefined>
}) => {
  const { getVerifiedEVaults } = useVaultRegistry()
  const { settings } = useUserSettings()
  const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
  const enableRewardsApy = computed(() => settings.value.enableRewardsApy)
  const { viewer } = useApyVisibility()
  const rewardCollateralAddresses = computed(() => {
    if (collateralAddresses?.value.length) return collateralAddresses.value
    return collateralVault.value?.address ? [collateralVault.value.address] : []
  })

  const allBorrowVaults = computed(() => {
    const currentBorrowAddress = currentBorrowVault?.value
      ? getAddress(currentBorrowVault.value.address)
      : null

    return getVerifiedEVaults().filter((vault) => {
      if (currentBorrowAddress && getAddress(vault.address) === currentBorrowAddress) {
        return false
      }
      return vault.isBorrowable
        && vault.totalAssets > 0n
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
    const currentVault = getLayeredVault(vault.address, vault)!
    const apy = computeBorrowApy(
      currentVault,
      viewer.value,
      {
        enableIntrinsicApy: enableIntrinsicApy.value,
        enableRewardsApy: enableRewardsApy.value,
      },
      rewardCollateralAddresses.value,
    )
    return buildCollateralOption({ vault: currentVault, type: 'vault', amount: 0, priceAmount: 0, apy, tagContext: 'swap-target', showBalance: false })
  }

  const borrowOptions = useReactiveMap(
    borrowVaults,
    [viewer, enableIntrinsicApy, enableRewardsApy, rewardCollateralAddresses, activeLayerVaultsRef],
    buildBorrowOption,
  )

  const allBorrowOptions = useReactiveMap(
    allBorrowVaults,
    [viewer, enableIntrinsicApy, enableRewardsApy, collateralVault, rewardCollateralAddresses, activeLayerVaultsRef],
    buildBorrowOption,
  )

  return {
    borrowVaults,
    borrowOptions,
    allBorrowVaults,
    allBorrowOptions,
  }
}
