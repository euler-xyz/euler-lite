import { isEVault, type EVault, type PortfolioBorrowPosition, type VaultEntity } from '@eulerxyz/euler-v2-sdk'
import {
  getProjectedRatesBatch,
  type ProjectedRatesRequest,
} from '~/utils/vault/apy'
import { getCollateralUsdValue } from '~/utils/sdk-prices'
import { getVaultSupplyApy } from '~/utils/vault-display'
import { withProjectedVaultIntrinsicApy } from '~/utils/vault-intrinsic-apy'
import { normalizeAddressOrEmpty } from '~/utils/accountPositionHelpers'
import { nanoToValue } from '~/utils/crypto-utils'
import { logWarn } from '~/utils/errorHandling'
import type { RewardCampaign } from '~/entities/reward-campaign'
import { activeLayerVaultsRef, useLayeredVaults } from '~/composables/useLayeredVaults'

interface CollateralApyDelta {
  vaultAddress: string
  assetsDelta: bigint
  cashDelta?: bigint
  projectRates?: boolean
}

interface CollateralApySnapshotOptions {
  deltas?: CollateralApyDelta[]
}

export interface CollateralApySnapshotEntry {
  address: string
  vault: VaultEntity
  assets: bigint
  supplyUsd: number
  baseSupplyApy: number
  intrinsicSupplyApy: number
  supplyRewardApy: number
  totalSupplyApy: number
  supplyCampaigns: RewardCampaign[]
}

export interface CollateralApySnapshot {
  supplyUsd: number
  weightedSupplyApy: number | null
  weightedBaseSupplyApy: number | null
  weightedIntrinsicSupplyApy: number | null
  weightedSupplyRewardApy: number | null
  collateralAddresses: string[]
  entries: CollateralApySnapshotEntry[]
  isComplete: boolean
}

interface CollateralApyEntry {
  address: string
  vault: VaultEntity
  assets: bigint
  delta: bigint
  cashDelta: bigint
  projectRates: boolean | undefined
}

export const usePositionCollateralApy = () => {
  const {
    getSupplyRewardApy,
    getSupplyRewardCampaigns,
    version: rewardsVersion,
  } = useRewardsApy()
  const { resolveLayeredVault } = useLayeredVaults()
  const { isReady: isVaultsReady, isMarketDataResolved } = useVaults()
  const { settings } = useUserSettings()
  const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)

  const getPositionCollateral = (
    position: PortfolioBorrowPosition<VaultEntity>,
    vaultAddress: string,
    primaryAddress: string,
  ) => (
    position.collaterals.find(c =>
      normalizeAddressOrEmpty(c.vaultAddress) === vaultAddress)
    ?? (vaultAddress === primaryAddress ? position.collateral : undefined)
  )

  const getCollateralAssets = (
    position: PortfolioBorrowPosition<VaultEntity>,
    vaultAddress: string,
    primaryAddress: string,
  ) => {
    // Collateral assets from the (layer-aware) position rather than a direct
    // lens read, so the snapshot reflects the active batch layer. Collateral
    // the sub-account doesn't hold isn't in `collaterals` ⇒ 0.
    const match = getPositionCollateral(position, vaultAddress, primaryAddress)
    if (match) return match.assets
    return vaultAddress === primaryAddress ? (position.supplied || 0n) : 0n
  }

  const getCollateralApySnapshot = async (
    position: PortfolioBorrowPosition<VaultEntity> | null | undefined,
    liabilityVault: EVault | undefined,
    options: CollateralApySnapshotOptions = {},
  ): Promise<CollateralApySnapshot> => {
    const incompleteSnapshot = (): CollateralApySnapshot => ({
      supplyUsd: 0,
      weightedSupplyApy: null,
      weightedBaseSupplyApy: null,
      weightedIntrinsicSupplyApy: null,
      weightedSupplyRewardApy: null,
      collateralAddresses: [],
      entries: [],
      isComplete: false,
    })

    if (!position || !liabilityVault) {
      return incompleteSnapshot()
    }

    try {
      // These reads happen before the first await so an async watchEffect that
      // calls this helper tracks enrichment, reward, and settings changes.
      void rewardsVersion.value
      const intrinsicApyEnabled = enableIntrinsicApy.value
      void isMarketDataResolved.value
      void activeLayerVaultsRef.value

      await until(isVaultsReady).toBe(true)
      if (!isMarketDataResolved.value) {
        const resolved = await Promise.race([
          until(isMarketDataResolved).toBe(true).then(() => true),
          new Promise<false>(resolve => setTimeout(() => resolve(false), 10_000)),
        ])
        if (!resolved) return incompleteSnapshot()
      }

      const primaryAddress = normalizeAddressOrEmpty(position.collateral?.vaultAddress)
      const deltaByAddress = new Map(
        (options.deltas || [])
          .map(delta => [normalizeAddressOrEmpty(delta.vaultAddress), delta])
          .filter(([address]) => Boolean(address)) as Array<[string, CollateralApyDelta]>,
      )
      const collateralAddresses = position.collaterals.map(c => normalizeAddressOrEmpty(c.vaultAddress))
      const expectedCollateralAddresses = (position.collateralVaults ?? []).map(normalizeAddressOrEmpty).filter(Boolean)
      const resolvedCollateralAddresses = new Set([primaryAddress, ...collateralAddresses].filter(Boolean))
      if (expectedCollateralAddresses.some(address => !resolvedCollateralAddresses.has(address))) {
        return incompleteSnapshot()
      }
      const allAddresses = Array.from(new Set([
        primaryAddress,
        ...collateralAddresses,
        ...expectedCollateralAddresses,
        ...deltaByAddress.keys(),
      ].filter(Boolean)))

      const resolvedEntries = await Promise.all(allAddresses.map(async (address): Promise<CollateralApyEntry | null> => {
        const existingCollateral = getPositionCollateral(position, address, primaryAddress)
        const vault = await resolveLayeredVault(address, existingCollateral?.vault)
        if (!vault) return null
        const currentAssets = getCollateralAssets(position, address, primaryAddress)
        const delta = deltaByAddress.get(address)?.assetsDelta || 0n
        const nextAssets = currentAssets + delta
        return {
          address,
          vault,
          assets: nextAssets > 0n ? nextAssets : 0n,
          delta,
          cashDelta: deltaByAddress.get(address)?.cashDelta ?? delta,
          projectRates: deltaByAddress.get(address)?.projectRates,
        }
      }))
      if (resolvedEntries.some(entry => entry === null)) return incompleteSnapshot()
      const entries = resolvedEntries as CollateralApyEntry[]

      const projectionRequests = entries.reduce<Array<{ index: number, request: ProjectedRatesRequest }>>((acc, entry, index) => {
        if (!entry.projectRates || entry.cashDelta === 0n || !isEVault(entry.vault)) return acc
        acc.push({
          index,
          request: {
            vaultAddress: entry.vault.address,
            currentCash: entry.vault.totalCash,
            currentBorrows: entry.vault.totalBorrowed,
            cashDelta: entry.cashDelta,
            borrowsDelta: 0n,
          },
        })
        return acc
      }, [])
      const projectedRates = projectionRequests.length
        ? await getProjectedRatesBatch(projectionRequests.map(item => item.request))
        : []
      if (
        projectedRates.length !== projectionRequests.length
        || projectedRates.some(projected => projected === null)
      ) {
        return incompleteSnapshot()
      }
      const projectedByIndex = new Map(projectionRequests.map((item, index) => [item.index, projectedRates[index]]))

      const valued = await Promise.all(entries.map(async (entry, index) => {
        const supplyUsd = entry.assets === 0n
          ? 0
          : await getCollateralUsdValue(entry.assets, liabilityVault, entry.vault, 'off-chain')
        if (supplyUsd === undefined || !Number.isFinite(supplyUsd) || (entry.assets > 0n && supplyUsd <= 0)) return null
        const currentRaw = getVaultSupplyApy(entry.vault)
        const projected = projectedByIndex.get(index)
        const projectedRaw = projected ? nanoToValue(projected.supplyAPY, 25) : null
        const baseSupplyApy = projectedRaw ?? currentRaw
        const supplyApyWithIntrinsic = withProjectedVaultIntrinsicApy(
          currentRaw,
          projectedRaw,
          entry.vault,
          intrinsicApyEnabled,
        )
        const supplyRewardApy = getSupplyRewardApy(entry.vault.address)
        const totalSupplyApy = supplyApyWithIntrinsic + supplyRewardApy

        return {
          address: entry.address,
          vault: entry.vault,
          assets: entry.assets,
          supplyUsd,
          baseSupplyApy,
          intrinsicSupplyApy: supplyApyWithIntrinsic - baseSupplyApy,
          supplyRewardApy,
          totalSupplyApy,
          supplyCampaigns: getSupplyRewardCampaigns(entry.vault.address),
        }
      }))
      if (valued.some(entry => entry === null)) return incompleteSnapshot()
      const completeValues = valued as CollateralApySnapshotEntry[]

      const supplyUsd = completeValues.reduce((sum, item) => sum + item.supplyUsd, 0)
      const positiveCollateralAddresses = entries.filter(entry => entry.assets > 0n).map(entry => entry.address)
      if (!Number.isFinite(supplyUsd) || supplyUsd <= 0) {
        return {
          supplyUsd: 0,
          weightedSupplyApy: null,
          weightedBaseSupplyApy: null,
          weightedIntrinsicSupplyApy: null,
          weightedSupplyRewardApy: null,
          collateralAddresses: positiveCollateralAddresses,
          entries: completeValues,
          isComplete: true,
        }
      }

      const weighted = (select: (item: CollateralApySnapshotEntry) => number) =>
        completeValues.reduce((sum, item) => sum + item.supplyUsd * select(item), 0) / supplyUsd

      return {
        supplyUsd,
        weightedSupplyApy: weighted(item => item.totalSupplyApy),
        weightedBaseSupplyApy: weighted(item => item.baseSupplyApy),
        weightedIntrinsicSupplyApy: weighted(item => item.intrinsicSupplyApy),
        weightedSupplyRewardApy: weighted(item => item.supplyRewardApy),
        collateralAddresses: positiveCollateralAddresses,
        entries: completeValues,
        isComplete: true,
      }
    }
    catch (error) {
      logWarn('positionCollateralApy/snapshot', error)
      return incompleteSnapshot()
    }
  }

  return {
    getCollateralApySnapshot,
  }
}
