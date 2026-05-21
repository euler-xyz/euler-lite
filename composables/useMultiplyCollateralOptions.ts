import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { buildCollateralOption, computeSupplyApy } from '~/utils/collateralOptions'
import { useReactiveMap } from '~/composables/useReactiveMap'
import { shouldIncludeWalletCollateral } from '~/utils/collateralFilters'
import type { CollateralOption } from '~/types/collateral-option'
import { getAddress, type Address } from 'viem'
import { useVaultRegistry } from '~/composables/useVaultRegistry'

type CollateralItem = {
  vault: EVault
  option: CollateralOption
}

export const useMultiplyCollateralOptions = ({
  primaryCollateralVault,
  liabilityVault,
}: {
  primaryCollateralVault: Ref<EVault | undefined>
  liabilityVault?: Ref<EVault | undefined>
}) => {
  const { getVault } = useVaultRegistry()
  const { getBalance } = useWallets()
  const { depositPositions } = useEulerAccount()
  const { settings } = useUserSettings()
  const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
  const enableRewardsApy = computed(() => settings.value.enableRewardsApy)
  const { viewer } = useApyVisibility()
  const visibilitySettings = computed(() => ({
    enableIntrinsicApy: enableIntrinsicApy.value,
    enableRewardsApy: enableRewardsApy.value,
  }))

  const primaryCollateralAddress = computed(() => {
    const primary = primaryCollateralVault.value
    return primary ? getAddress(primary.address) : ''
  })

  const walletItemsInput = computed(() => {
    const liability = liabilityVault?.value
    if (!liability) {
      return []
    }

    const items: { vault: EVault, balance: bigint }[] = []
    liability.collaterals
      .filter(ltv => ltv.borrowLTV > 0)
      .forEach((ltv) => {
        const vault = getVault(ltv.address) as EVault | undefined
        if (!vault) return

        const balance = getBalance(vault.asset.address as Address)
        if (!shouldIncludeWalletCollateral({
          balance,
          vaultAddress: vault.address as Address,
          primaryCollateralAddress: primaryCollateralAddress.value as Address | '',
        })) return

        items.push({ vault, balance })
      })

    return items
  })

  const walletItems = useReactiveMap(
    walletItemsInput,
    [viewer, enableIntrinsicApy, enableRewardsApy],
    async ({ vault, balance }) => ({
      vault,
      option: await buildCollateralOption({
        vault, type: 'wallet',
        amount: nanoToValue(balance, vault.asset.decimals),
        priceAmount: nanoToValue(balance, vault.asset.decimals),
        apy: computeSupplyApy(vault, viewer.value, visibilitySettings.value),
        tagContext: 'supply-source',
      }),
    } as CollateralItem),
  )

  const savingItemsInput = computed(() => {
    const liability = liabilityVault?.value
    if (!liability) return []
    const validCollaterals = new Set(
      liability.collaterals.filter(ltv => ltv.borrowLTV > 0).map(ltv => getAddress(ltv.address)),
    )
    // Enumerate one entry per (vault × sub-account) so a user with savings of
    // the same vault in multiple sub-accounts gets distinct options.
    return depositPositions.value
      .map(position => ({ position, vault: position.vault as EVault | undefined }))
      .filter(({ position, vault }) => !!vault && position.assets > 0n && validCollaterals.has(getAddress(vault.address)))
      .map(({ position, vault }) => ({
        vault: vault!,
        assets: position.assets,
        subAccount: position.subAccount as string,
      }))
  })

  const savingItems = useReactiveMap(
    savingItemsInput,
    [viewer, enableIntrinsicApy, enableRewardsApy],
    async ({ vault, assets, subAccount }) => ({
      vault,
      option: await buildCollateralOption({
        vault, type: 'saving',
        amount: nanoToValue(assets, vault.asset.decimals),
        priceAmount: nanoToValue(assets, vault.asset.decimals),
        apy: computeSupplyApy(vault, viewer.value, visibilitySettings.value),
        tagContext: 'supply-source',
        subAccount,
      }),
    } as CollateralItem),
  )

  const combinedItems = computed<CollateralItem[]>(() => {
    const items = [...savingItems.value, ...walletItems.value]
    items.sort((a, b) => (b.option.price || 0) - (a.option.price || 0))
    return items
  })

  const collateralOptions = computed<CollateralOption[]>(() => {
    return combinedItems.value.map(item => item.option)
  })

  const collateralVaults = computed<EVault[]>(() => {
    return combinedItems.value.map(item => item.vault)
  })

  return {
    collateralOptions,
    collateralVaults,
  }
}
