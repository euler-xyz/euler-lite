import type { EVault, PortfolioSavingsPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { getAddress } from 'viem'
import { getVaultProductName } from '~/utils/eulerLabelsUtils'
import { withVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import { useVaultRegistry } from '~/composables/useVaultRegistry'

import { getAssetUsdValueOrZero } from '~/utils/sdk-prices'
import { nanoToValue } from '~/utils/crypto-utils'
import { useReactiveMap } from '~/composables/useReactiveMap'

/**
 * Provides eligible savings positions that can be used to repay debt.
 * Only includes standard EVK vaults.
 *
 * Earn vaults are excluded: they expose a MetaMorpho-style ABI that doesn't
 * line up with the EVK withdraw/skim/repayWithShares dance the repay plans
 * rely on.
 *
 * Securitize vaults are excluded because the repay plan would call
 * `savingsVault.withdraw(amount, borrowVault, ...)` — pushing the underlying
 * ERC-20 directly into the borrow vault. Securitize underlyings (tokenized
 * RWAs) are themselves permissioned tokens whose transfer reverts unless the
 * recipient is on a whitelist. The borrow vault isn't on that whitelist, so
 * the withdraw step would revert at the ERC-20 transfer. It is not the
 * missing `skim` that blocks this path — `skim` is called on the borrow
 * vault (always EVK), not on the savings side.
 */
export const useRepaySavingsOptions = () => {
  const { depositPositions } = useEulerAccount()
  const { isEVaultAddress } = useVaultRegistry()
  const { settings } = useUserSettings()
  const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
  const { getSupplyRewardApy, version: rewardsVersion } = useRewardsApy()

  const savingsPositions = computed(() => {
    return depositPositions.value.filter((position) => {
      const vault = position.vault
      if (!vault || !isEVaultAddress(vault.address)) {
        return false
      }
      if (position.assets <= 0n) {
        return false
      }
      return true
    })
  })

  const savingsVaults = computed(() => {
    return savingsPositions.value
      .map(position => position.vault as EVault | undefined)
      .filter((vault): vault is EVault => !!vault)
  })

  const savingsOptions = useReactiveMap(
    savingsPositions,
    [rewardsVersion, enableIntrinsicApy],
    async (position) => {
      const vault = position.vault as EVault | undefined
      if (!vault) {
        throw new Error('Savings vault not resolved')
      }
      const amount = nanoToValue(position.assets, vault.asset.decimals)
      const baseApy = getVaultSupplyApy(vault)
      const apy = withVaultIntrinsicApy(baseApy, vault, enableIntrinsicApy.value) + getSupplyRewardApy(vault.address)
      return {
        type: 'vault' as const,
        amount,
        price: await getAssetUsdValueOrZero(amount, vault, 'off-chain'),
        apy,
        symbol: vault.asset.symbol,
        assetAddress: vault.asset.address,
        label: getVaultProductName(vault.address) || vault.shares.name,
        vaultAddress: vault.address,
        subAccount: position.subAccount as string,
      }
    },
  )

  /**
   * Look up a savings position by vault + sub-account. Fail-closed when
   * `subAccount` is omitted but the user has positions of the same vault in
   * more than one sub-account — otherwise we'd silently default to the first
   * match and the form would redeem from the wrong account.
   */
  const getSavingsPosition = (
    vaultAddress: string,
    subAccount?: string,
  ): PortfolioSavingsPosition<VaultEntity> | undefined => {
    const normalized = getAddress(vaultAddress)
    const matches = savingsPositions.value.filter(
      position => getAddress(position.vault?.address || '0x0000000000000000000000000000000000000000') === normalized,
    )
    if (matches.length === 0) return undefined
    if (subAccount) {
      const wantedSub = getAddress(subAccount)
      return matches.find(p => getAddress(p.subAccount) === wantedSub)
    }
    // No sub-account specified: only safe to default-pick when there's exactly one match.
    return matches.length === 1 ? matches[0] : undefined
  }

  return {
    savingsPositions,
    savingsVaults,
    savingsOptions,
    getSavingsPosition,
  }
}
