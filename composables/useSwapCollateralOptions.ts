import { getAddress, type Address } from 'viem'
import { useIntrinsicApy } from '~/composables/useIntrinsicApy'
import { useVaultRegistry } from '~/composables/useVaultRegistry'
import type { EVault } from '~/entities/vault'
import type { VaultTagContext } from '~/composables/useGeoBlock'
import { buildCollateralOption, computeSupplyApy } from '~/utils/collateralOptions'
import { useReactiveMap } from '~/composables/useReactiveMap'

export const useSwapCollateralOptions = ({
  currentVault,
  liabilityVault,
  tagContext = 'swap-target',
}: {
  currentVault: Ref<EVault | undefined>
  liabilityVault?: Ref<EVault | undefined>
  tagContext?: VaultTagContext
}) => {
  const { borrowList } = useVaults()
  const { getVault: registryGetVault, getVerifiedEvkVaults, getEscrowVaults, getVaultCategory } = useVaultRegistry()
  const { getBalance } = useWallets()
  const { withIntrinsicSupplyApy, version: intrinsicVersion } = useIntrinsicApy()
  const { getSupplyRewardApy, version: rewardsVersion } = useRewardsApy()

  const collateralVaults = computed(() => {
    const current = currentVault.value
    const currentAddress = current ? getAddress(current.address) : null
    const liability = liabilityVault?.value

    let candidates: EVault[] = []

    if (liability) {
      // When we have a liability vault, get collaterals from LTV configuration
      candidates = liability.collaterals
        .filter(ltv => ltv.borrowLTV > 0)
        .map(ltv => registryGetVault(ltv.address) as EVault | undefined)
        .filter((vault): vault is EVault => Boolean(vault))
    }
    else {
      // Without liability vault, show borrowable vaults + all escrow vaults
      const borrowable = new Set(
        borrowList.value.map(pair => getAddress(pair.borrow.address)),
      )
      // Get verified EVK vaults that are borrowable and non-escrow
      const standardVaults = getVerifiedEvkVaults()
        .filter(vault => getVaultCategory(vault.address) !== 'escrow')
        .filter(vault => borrowable.has(getAddress(vault.address)))
      // Get all escrow vaults (always valid as collateral, already have verified: true)
      const escrowVaults = getEscrowVaults()

      candidates = [...standardVaults, ...escrowVaults]
    }

    const unique = new Map<string, EVault>()
    candidates.forEach((vault) => {
      const address = getAddress(vault.address)
      if (currentAddress && address === currentAddress) {
        return
      }
      if (!unique.has(address)) {
        unique.set(address, vault)
      }
    })

    return [...unique.values()]
  })

  const collateralOptions = useReactiveMap(
    collateralVaults,
    [rewardsVersion, intrinsicVersion],
    async (vault) => {
      const balance = getBalance(vault.asset.address as Address)
      const amount = nanoToValue(balance, vault.asset.decimals)
      const apy = computeSupplyApy(vault, withIntrinsicSupplyApy, getSupplyRewardApy)
      const type = getVaultCategory(vault.address) === 'escrow' ? 'escrow' : 'vault'
      return buildCollateralOption({ vault, type, amount, priceAmount: amount, apy, tagContext })
    },
  )

  return {
    collateralVaults,
    collateralOptions,
  }
}
