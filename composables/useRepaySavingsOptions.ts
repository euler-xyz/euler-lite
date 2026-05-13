import { getAddress } from 'viem'
import { getVaultProductName } from '~/utils/eulerLabelsUtils'
import { useIntrinsicApy } from '~/composables/useIntrinsicApy'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import type { AccountDepositPosition } from '~/entities/account'
import type { Vault } from '~/entities/vault'
import { getAssetUsdValueOrZero } from '~/services/pricing/priceProvider'
import { nanoToValue } from '~/utils/crypto-utils'
import { useReactiveMap } from '~/composables/useReactiveMap'
import { computeSupplyApy } from '~/utils/collateralOptions'

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
    return savingsPositions.value.map(position => position.vault as Vault)
  })

  const savingsOptions = useReactiveMap(
    savingsPositions,
    [rewardsVersion, intrinsicVersion],
    async (position) => {
      const vault = position.vault as Vault
      const amount = nanoToValue(position.assets, vault.asset.decimals)
      const apy = computeSupplyApy(vault, withIntrinsicSupplyApy, getSupplyRewardApy)
      return {
        type: 'saving' as const,
        amount,
        price: await getAssetUsdValueOrZero(amount, vault, 'off-chain'),
        apy,
        symbol: vault.asset.symbol,
        assetAddress: vault.asset.address,
        label: getVaultProductName(vault.address) || vault.name,
        vaultAddress: vault.address,
        subAccount: position.subAccount,
      }
    },
  )

  // When a sub-account is explicitly requested, require an exact match instead
  // of falling back to the first matching vault — silently picking a different
  // sub-account would route a repay against the wrong position.
  const getSavingsPosition = (vaultAddress: string, subAccount?: string): AccountDepositPosition | undefined => {
    const normalizedVault = getAddress(vaultAddress)
    const matches = savingsPositions.value.filter(
      position => getAddress(position.vault.address) === normalizedVault,
    )
    if (subAccount) {
      const normalizedSub = getAddress(subAccount)
      return matches.find(p => getAddress(p.subAccount) === normalizedSub)
    }
    return matches[0]
  }

  return {
    savingsPositions,
    savingsVaults,
    savingsOptions,
    getSavingsPosition,
  }
}
