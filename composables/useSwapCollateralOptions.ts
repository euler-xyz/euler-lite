import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { getAddress, maxUint256, type Address } from 'viem'
import { useVaultRegistry } from '~/composables/useVaultRegistry'

import type { VaultTagContext } from '~/composables/useGeoBlock'
import { buildCollateralOption, computeSupplyApy } from '~/utils/collateralOptions'
import { useReactiveMap } from '~/composables/useReactiveMap'
import { isOpDisabled, OP_SKIM } from '~/utils/vault-hooks'

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
  const { getVault: registryGetVault, getVerifiedEVaults, getEscrowVaults, getVaultCategory } = useVaultRegistry()
  const { getBalance } = useWallets()
  const { settings } = useUserSettings()
  const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
  const enableRewardsApy = computed(() => settings.value.enableRewardsApy)
  const { viewer } = useApyVisibility()

  const filterTargetCollateralCandidates = (candidates: EVault[], currentAddress: string | null) => {
    const unique = new Map<string, EVault>()
    candidates.forEach((vault) => {
      const address = getAddress(vault.address)
      if (currentAddress && address === currentAddress) {
        return
      }
      if (vault.totalAssets <= 0n || vault.caps.supplyCap === 0n) {
        return
      }
      if (vault.caps.supplyCap < maxUint256 && vault.totalAssets >= vault.caps.supplyCap) {
        return
      }
      if (isOpDisabled(vault, OP_SKIM)) {
        return
      }
      if (!unique.has(address)) {
        unique.set(address, vault)
      }
    })

    return [...unique.values()]
  }

  const baseCollateralCandidates = computed(() => {
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
      // Get verified EVaults that are borrowable and non-escrow
      const standardVaults = getVerifiedEVaults()
        .filter(vault => getVaultCategory(vault.address) !== 'escrow')
        .filter(vault => borrowable.has(getAddress(vault.address)))
      // Get all escrow vaults (always valid as collateral, already have verified: true)
      const escrowVaults = getEscrowVaults()

      candidates = [...standardVaults, ...escrowVaults]
    }

    return filterTargetCollateralCandidates(candidates, currentAddress)
  })

  const allCollateralVaults = computed(() => {
    const current = currentVault.value
    const currentAddress = current ? getAddress(current.address) : null
    return filterTargetCollateralCandidates(
      [...getVerifiedEVaults(), ...getEscrowVaults()],
      currentAddress,
    )
  })

  const collateralOptions = useReactiveMap(
    baseCollateralCandidates,
    [viewer, enableIntrinsicApy, enableRewardsApy],
    buildCollateralOptionForVault,
  )

  const allCollateralOptions = useReactiveMap(
    allCollateralVaults,
    [viewer, enableIntrinsicApy, enableRewardsApy],
    buildCollateralOptionForVault,
  )

  async function buildCollateralOptionForVault(vault: EVault) {
    const balance = getBalance(vault.asset.address as Address)
    const amount = nanoToValue(balance, vault.asset.decimals)
    const apy = computeSupplyApy(vault, viewer.value, {
      enableIntrinsicApy: enableIntrinsicApy.value,
      enableRewardsApy: enableRewardsApy.value,
    })
    const type = getVaultCategory(vault.address) === 'escrow' ? 'escrow' : 'vault'
    return buildCollateralOption({ vault, type, amount, priceAmount: amount, apy, tagContext })
  }

  return {
    collateralVaults: baseCollateralCandidates,
    collateralOptions,
    allCollateralVaults,
    allCollateralOptions,
  }
}
