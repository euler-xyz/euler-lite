import { getAddress, type Abi, type Address } from 'viem'
import type { AccountBorrowPosition } from '~/entities/account'
import { eulerAccountLensABI } from '~/entities/euler/abis'
import {
  getProjectedRatesBatch,
  type ProjectedRatesRequest,
  type SecuritizeVault,
  type Vault,
} from '~/entities/vault'
import { getCollateralUsdValueOrZero } from '~/services/pricing/priceProvider'
import { nanoToValue } from '~/utils/crypto-utils'

type PositionCollateralVault = Vault | SecuritizeVault

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
  vault: PositionCollateralVault
  assets: bigint
  delta: bigint
  projectRates: boolean | undefined
}

export const usePositionCollateralApy = () => {
  const { getSupplyRewardApy } = useRewardsApy()
  const { withIntrinsicSupplyApy } = useIntrinsicApy()
  const { getOrFetch } = useVaultRegistry()
  const { isReady: isVaultsReady } = useVaults()
  const { eulerLensAddresses, isReady: isEulerAddressesReady, loadEulerConfig } = useEulerAddresses()
  const { client: rpcClient } = useRpcClient()

  const normalize = (address?: string | null) => {
    if (!address) return ''
    try {
      return getAddress(address)
    }
    catch {
      return ''
    }
  }

  const getCollateralAssets = async (
    position: AccountBorrowPosition,
    vaultAddress: string,
    primaryAddress: string,
  ) => {
    if (normalize(vaultAddress) === normalize(primaryAddress)) {
      return position.supplied || 0n
    }

    const lensAddress = eulerLensAddresses.value?.accountLens
    if (!lensAddress || !rpcClient.value) {
      return 0n
    }

    try {
      const res = await rpcClient.value.readContract({
        address: lensAddress as Address,
        abi: eulerAccountLensABI as Abi,
        functionName: 'getAccountInfo',
        args: [position.subAccount, vaultAddress],
      }) as Record<string, Record<string, unknown>>
      return res.vaultAccountInfo.assets as bigint
    }
    catch {
      return 0n
    }
  }

  const getCollateralApySnapshot = async (
    position: AccountBorrowPosition | null | undefined,
    liabilityVault: Vault | undefined,
    options: CollateralApySnapshotOptions = {},
  ): Promise<CollateralApySnapshot> => {
    if (!position || !liabilityVault) {
      return { supplyUsd: 0, weightedSupplyApy: null }
    }

    try {
      if (!isEulerAddressesReady.value) {
        await loadEulerConfig()
      }
      await until(isVaultsReady).toBe(true)

      const primaryAddress = normalize(position.collateral.address)
      const deltaByAddress = new Map(
        (options.deltas || [])
          .map(delta => [normalize(delta.vaultAddress), delta])
          .filter(([address]) => Boolean(address)) as Array<[string, CollateralApyDelta]>,
      )
      const collateralAddresses = position.collaterals?.length
        ? position.collaterals
        : [position.collateral.address]
      const normalized = collateralAddresses.map(normalize).filter(Boolean)
      const allAddresses = Array.from(new Set([
        primaryAddress,
        ...normalized,
        ...deltaByAddress.keys(),
      ].filter(Boolean)))

      const entries = (await Promise.all(allAddresses.map(async (address): Promise<CollateralApyEntry | null> => {
        const vault = await getOrFetch(address) as PositionCollateralVault | undefined
        if (!vault) return null
        const currentAssets = await getCollateralAssets(position, address, primaryAddress)
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
        if (!entry.projectRates || entry.delta === 0n) return acc
        acc.push({
          index,
          request: {
            vaultAddress: entry.vault.address,
            currentCash: entry.vault.interestRateInfo.cash,
            currentBorrows: entry.vault.interestRateInfo.borrows,
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
        const supplyUsd = await getCollateralUsdValueOrZero(entry.assets, liabilityVault, entry.vault as Vault, 'off-chain')
        const currentRaw = nanoToValue(entry.vault.interestRateInfo.supplyAPY || 0n, 25)
        const baseApy = withIntrinsicSupplyApy(currentRaw, entry.vault.asset.address) + getSupplyRewardApy(entry.vault.address)
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
