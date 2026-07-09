import { isEVault, type EVault, type PortfolioBorrowPosition, type VaultEntity } from '@eulerxyz/euler-v2-sdk'
import {
  getProjectedRatesBatch,
  type ProjectedRatesRequest,
} from '~/utils/vault/apy'
import { getCollateralUsdValueOrZero } from '~/utils/sdk-prices'
import { getVaultSupplyApy } from '~/utils/vault-display'
import { withVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import { normalizeAddressOrEmpty } from '~/utils/accountPositionHelpers'
import { nanoToValue } from '~/utils/crypto-utils'

interface CollateralApyDelta {
  vaultAddress: string
  assetsDelta: bigint
  projectRates?: boolean
}

interface CollateralApySnapshotOptions {
  deltas?: CollateralApyDelta[]
}

interface CollateralApySnapshot {
  supplyUsd: number
  weightedSupplyApy: number | null
}

interface CollateralApyEntry {
  address: string
  vault: VaultEntity
  assets: bigint
  delta: bigint
  projectRates: boolean | undefined
}

export const usePositionCollateralApy = () => {
  const { getSupplyRewardApy } = useRewardsApy()
  const { getOrFetch } = useVaultRegistry()
  const { isReady: isVaultsReady } = useVaults()
  const { settings } = useUserSettings()
  const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)

  const getCollateralAssets = (
    position: PortfolioBorrowPosition<VaultEntity>,
    vaultAddress: string,
    primaryAddress: string,
  ) => {
    // Collateral assets from the (layer-aware) position rather than a direct
    // lens read, so the snapshot reflects the active batch layer. Collateral
    // the sub-account doesn't hold isn't in `collaterals` ⇒ 0.
    const match = position.collaterals.find(c =>
      normalizeAddressOrEmpty(c.vaultAddress) === vaultAddress)
    if (match) return match.assets
    return vaultAddress === primaryAddress ? (position.supplied || 0n) : 0n
  }

  const getCollateralApySnapshot = async (
    position: PortfolioBorrowPosition<VaultEntity> | null | undefined,
    liabilityVault: EVault | undefined,
    options: CollateralApySnapshotOptions = {},
  ): Promise<CollateralApySnapshot> => {
    if (!position || !liabilityVault) {
      return { supplyUsd: 0, weightedSupplyApy: null }
    }

    try {
      await until(isVaultsReady).toBe(true)

      const primaryAddress = normalizeAddressOrEmpty(position.collateral?.vaultAddress)
      const deltaByAddress = new Map(
        (options.deltas || [])
          .map(delta => [normalizeAddressOrEmpty(delta.vaultAddress), delta])
          .filter(([address]) => Boolean(address)) as Array<[string, CollateralApyDelta]>,
      )
      const collateralAddresses = position.collaterals.map(c => normalizeAddressOrEmpty(c.vaultAddress))
      const allAddresses = Array.from(new Set([
        primaryAddress,
        ...collateralAddresses,
        ...deltaByAddress.keys(),
      ].filter(Boolean)))

      const entries = (await Promise.all(allAddresses.map(async (address): Promise<CollateralApyEntry | null> => {
        const vault = await getOrFetch(address)
        if (!vault) return null
        const currentAssets = getCollateralAssets(position, address, primaryAddress)
        const delta = deltaByAddress.get(address)?.assetsDelta || 0n
        const nextAssets = currentAssets + delta
        return {
          address,
          vault,
          assets: nextAssets > 0n ? nextAssets : 0n,
          delta,
          projectRates: deltaByAddress.get(address)?.projectRates,
        }
      }))).filter((entry): entry is CollateralApyEntry => entry !== null)

      const projectionRequests = entries.reduce<Array<{ index: number, request: ProjectedRatesRequest }>>((acc, entry, index) => {
        if (!entry.projectRates || entry.delta === 0n || !isEVault(entry.vault)) return acc
        acc.push({
          index,
          request: {
            vaultAddress: entry.vault.address,
            currentCash: entry.vault.totalCash,
            currentBorrows: entry.vault.totalBorrowed,
            cashDelta: entry.delta,
            borrowsDelta: 0n,
          },
        })
        return acc
      }, [])
      const projectedRates = projectionRequests.length
        ? await getProjectedRatesBatch(projectionRequests.map(item => item.request))
        : []
      const projectedByIndex = new Map(projectionRequests.map((item, index) => [item.index, projectedRates[index]]))

      const valued = await Promise.all(entries.map(async (entry, index) => {
        const supplyUsd = await getCollateralUsdValueOrZero(entry.assets, liabilityVault, entry.vault, 'off-chain')
        const currentRaw = getVaultSupplyApy(entry.vault)
        const baseApy = withVaultIntrinsicApy(currentRaw, entry.vault, enableIntrinsicApy.value) + getSupplyRewardApy(entry.vault.address)
        const projected = projectedByIndex.get(index)
        const supplyApy = projected
          ? baseApy + (nanoToValue(projected.supplyAPY, 25) - currentRaw)
          : baseApy

        return { supplyUsd, supplyApy }
      }))

      const supplyUsd = valued.reduce((sum, item) => sum + item.supplyUsd, 0)
      if (!Number.isFinite(supplyUsd) || supplyUsd <= 0) {
        return { supplyUsd: 0, weightedSupplyApy: null }
      }

      return {
        supplyUsd,
        weightedSupplyApy: valued.reduce((sum, item) => sum + item.supplyUsd * item.supplyApy, 0) / supplyUsd,
      }
    }
    catch {
      return { supplyUsd: 0, weightedSupplyApy: null }
    }
  }

  return {
    getCollateralApySnapshot,
  }
}
