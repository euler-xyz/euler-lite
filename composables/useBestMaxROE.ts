import type { MarketGroup } from '~/entities/lend-discovery'
import { isEVault } from '@eulerxyz/euler-v2-sdk'
import { type BestMaxRoeResult, getBorrowableVaults } from '~/utils/discoveryCalculations'
import { getMaxMultiplier, getMaxRoe } from '~/utils/leverage'
import {
  computeSupplyApy,
  computeBorrowApy,
  sumBorrowRewardApr,
  sumLoopingRewardApr,
} from '~/utils/collateralOptions'

/**
 * Computes the best max ROE for each market group by iterating all actual
 * collateral/liability pairs with LTV relationships. Uses leveraged return
 * (max ROE) instead of simple net APY spread.
 *
 * Returns a reactive map of marketGroupId -> BestMaxRoeResult.
 */
export const useBestMaxROE = (marketGroups: Ref<MarketGroup[]>) => {
  const { settings } = useUserSettings()
  const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
  const enableRewardsApy = computed(() => settings.value.enableRewardsApy)
  const { viewer } = useApyVisibility()

  const computeForGroup = (group: MarketGroup): BestMaxRoeResult => {
    const borrowableVaults = getBorrowableVaults(group)

    const allVaults = [...group.vaults, ...group.externalCollateral]
    const knownAddresses = new Set(
      allVaults.map(v => (isEVault(v) ? v.address : '').toLowerCase()).filter(Boolean),
    )

    const visibilitySettings = {
      enableIntrinsicApy: enableIntrinsicApy.value,
      enableRewardsApy: enableRewardsApy.value,
    }

    let best = -Infinity
    let bestHasRewards = false
    let bestPair = ''
    let bestMultiplier = 1
    let bestSupplyAPY = 0
    let bestBorrowAPY = 0
    let bestBorrowLTV = 0
    let bestBorrowVaultAddress = ''
    let bestCollateralAddress = ''

    for (const liability of borrowableVaults) {
      for (const ltv of liability.collaterals) {
        if (ltv.borrowLTV <= 0) continue
        const colAddr = ltv.address.toLowerCase()
        if (!knownAddresses.has(colAddr)) continue

        const collateral = allVaults.find(
          v => isEVault(v) && v.address.toLowerCase() === colAddr,
        )
        if (!collateral || !isEVault(collateral)) continue

        const supplyFinal = computeSupplyApy(collateral, viewer.value, visibilitySettings)
        const borrowFinal = computeBorrowApy(
          liability,
          viewer.value,
          visibilitySettings,
          collateral.address,
        )
        const maxMultiplier = getMaxMultiplier(ltv.borrowLTV)
        const loopingRewards = enableRewardsApy.value
          ? sumLoopingRewardApr(liability, viewer.value, collateral.address, maxMultiplier)
          : 0
        const roe = getMaxRoe(maxMultiplier, supplyFinal, borrowFinal, loopingRewards)

        const supplyHasRewards = enableRewardsApy.value
          && (liability.rewards || collateral.rewards) !== undefined
          && (sumBorrowRewardApr(liability, viewer.value, collateral.address) > 0
            || loopingRewards > 0
            || ((collateral.rewards?.getActiveCampaigns({ viewer: viewer.value }) ?? []).some(
              c => c.action === 'LEND' && typeof c.apr === 'number' && c.apr > 0,
            )))

        if (roe > best) {
          best = roe
          bestHasRewards = supplyHasRewards
          bestPair = `${collateral.asset.symbol}/${liability.asset.symbol}`
          bestMultiplier = maxMultiplier
          bestSupplyAPY = supplyFinal
          bestBorrowAPY = borrowFinal
          bestBorrowLTV = ltvToPercent(ltv.borrowLTV)
          bestBorrowVaultAddress = liability.address
          bestCollateralAddress = collateral.address
        }
      }
    }

    const value = Number.isFinite(best) && best > -Infinity ? best : 0
    return {
      value,
      hasRewards: bestHasRewards,
      pair: bestPair,
      maxMultiplier: bestMultiplier,
      supplyAPY: bestSupplyAPY,
      borrowAPY: bestBorrowAPY,
      borrowLTV: bestBorrowLTV,
      borrowVaultAddress: bestBorrowVaultAddress,
      collateralAddress: bestCollateralAddress,
    }
  }

  const bestMaxROEMap = computed((): Map<string, BestMaxRoeResult> => {
    void enableIntrinsicApy.value
    void enableRewardsApy.value
    void viewer.value

    const result = new Map<string, BestMaxRoeResult>()
    for (const group of marketGroups.value) {
      result.set(group.id, computeForGroup(group))
    }
    return result
  })

  const defaultResult: BestMaxRoeResult = {
    value: 0,
    hasRewards: false,
    pair: '',
    maxMultiplier: 1,
    supplyAPY: 0,
    borrowAPY: 0,
    borrowLTV: 0,
    borrowVaultAddress: '',
    collateralAddress: '',
  }

  const getBestMaxROE = (groupId: string): BestMaxRoeResult => {
    return bestMaxROEMap.value.get(groupId) ?? defaultResult
  }

  return {
    bestMaxROEMap,
    getBestMaxROE,
  }
}
