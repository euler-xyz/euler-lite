import { getAddress } from 'viem'
import { getVaultProductName } from '~/utils/eulerLabelsUtils'
import { useIntrinsicApy } from '~/composables/useIntrinsicApy'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import type { AccountDepositPosition } from '~/entities/account'
import type { EVault } from '~/entities/vault'
import { getAssetUsdValueOrZero } from '~/services/pricing/priceProvider'
import { nanoToValue } from '~/utils/crypto-utils'
import { useReactiveMap } from '~/composables/useReactiveMap'

/**
 * Provides eligible savings positions that can be used to repay debt.
 * Only includes standard EVK vaults — Earn vaults have an incompatible ABI
 * and Securitize vaults have restricted withdrawals.
 */
export const useRepaySavingsOptions = () => {
  const { depositPositions } = useEulerAccount()
  const { isEvkVault } = useVaultRegistry()
  const { withIntrinsicSupplyApy, version: intrinsicVersion } = useIntrinsicApy()
  const { getSupplyRewardApy, version: rewardsVersion } = useRewardsApy()

  const savingsPositions = computed(() => {
    return depositPositions.value.filter((position) => {
      if (!isEvkVault(position.vault.address)) {
        return false
      }
      if (position.assets <= 0n) {
        return false
      }
      return true
    })
  })

  const savingsVaults = computed(() => {
    return savingsPositions.value.map(position => position.vault as EVault)
  })

  const savingsOptions = useReactiveMap(
    savingsPositions,
    [rewardsVersion, intrinsicVersion],
    async (position) => {
      const vault = position.vault
      const amount = nanoToValue(position.assets, vault.asset.decimals)
      const baseApy = getVaultSupplyApy(vault)
      const apy = withIntrinsicSupplyApy(baseApy, vault.asset.address) + getSupplyRewardApy(vault.address)
      return {
        type: 'vault' as const,
        amount,
        price: await getAssetUsdValueOrZero(amount, vault, 'off-chain'),
        apy,
        symbol: vault.asset.symbol,
        assetAddress: vault.asset.address,
        label: getVaultProductName(vault.address) || vault.shares.name,
        vaultAddress: vault.address,
      }
    },
  )

  const getSavingsPosition = (vaultAddress: string): AccountDepositPosition | undefined => {
    const normalized = getAddress(vaultAddress)
    return savingsPositions.value.find(
      position => getAddress(position.vault.address) === normalized,
    )
  }

  return {
    savingsPositions,
    savingsVaults,
    savingsOptions,
    getSavingsPosition,
  }
}
