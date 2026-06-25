import type { MarketGroup } from '~/entities/lend-discovery'
import { areTokenAddressesCorrelatedByTags } from '~/utils/token-categories'
import { type BestMaxRoeResult, getBorrowableVaults, getVaultAddress, getVaultAssetAddress, getVaultAssetSymbol } from '~/utils/discoveryCalculations'
import { getMaxMultiplier, getMaxRoe } from '~/utils/leverage'
import {
  computeSupplyApy,
  computeBorrowApy,
  sumBorrowRewardApr,
  sumLoopingRewardApr,
} from '~/utils/collateralOptions'

type LendRewardCampaign = { action?: string, apr?: number }
type MaybeRewardedVault = {
  rewards?: {
    getActiveCampaigns: (params: { viewer: string | undefined }) => LendRewardCampaign[]
  }
}

const getLendRewardCampaigns = (vault: unknown, viewer: string | undefined): LendRewardCampaign[] => {
  if (!vault || typeof vault !== 'object' || !('rewards' in vault)) return []
  return (vault as MaybeRewardedVault).rewards?.getActiveCampaigns({ viewer }) ?? []
}

/**
 * Computes the headline metric for each market group by iterating actual
 * collateral/liability pairs with LTV relationships. Correlated pairs use
 * leveraged return (max ROE); groups without a correlated pair fall back to
 * the best visible net APY.
 *
 * Returns a reactive map of marketGroupId -> BestMaxRoeResult.
 */
export const useBestMaxROE = (marketGroups: Ref<MarketGroup[]>) => {
  const { settings } = useUserSettings()
  const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
  const enableRewardsApy = computed(() => settings.value.enableRewardsApy)
  const { viewer } = useApyVisibility()
  const { getTokenCategoryTags } = useTokenList()

  const computeForGroup = (group: MarketGroup): BestMaxRoeResult => {
    const borrowableVaults = getBorrowableVaults(group)

    const allVaults = [...group.vaults, ...group.externalCollateral]
    const knownAddresses = new Set(
      allVaults.map(v => getVaultAddress(v).toLowerCase()).filter(Boolean),
    )
    const vaultsByAddress = new Map(
      allVaults
        .map(v => [getVaultAddress(v).toLowerCase(), v] as const)
        .filter(([address]) => Boolean(address)),
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
    let fallback = -Infinity
    let fallbackHasRewards = false
    let fallbackPair = ''
    let fallbackSupplyAPY = 0
    let fallbackBorrowAPY = 0
    let fallbackBorrowVaultAddress = ''
    let fallbackCollateralAddress = ''

    for (const liability of borrowableVaults) {
      for (const ltv of liability.collaterals) {
        if (ltv.borrowLTV <= 0) continue
        const colAddr = ltv.address.toLowerCase()
        if (!knownAddresses.has(colAddr)) continue

        const collateral = vaultsByAddress.get(colAddr)
        if (!collateral) continue
        const collateralAddress = getVaultAddress(collateral)

        const supplyFinal = computeSupplyApy(collateral, viewer.value, visibilitySettings)
        const borrowFinal = computeBorrowApy(
          liability,
          viewer.value,
          visibilitySettings,
          collateralAddress,
        )
        const maxMultiplier = getMaxMultiplier(ltv.borrowLTV)
        const loopingRewards = enableRewardsApy.value
          ? sumLoopingRewardApr(liability, viewer.value, collateralAddress, maxMultiplier)
          : 0
        const roe = getMaxRoe(maxMultiplier, supplyFinal, borrowFinal, loopingRewards)
        const collateralLendCampaigns = getLendRewardCampaigns(collateral, viewer.value)

        const supplyHasRewards = enableRewardsApy.value
          && (liability.rewards !== undefined || collateralLendCampaigns.length > 0)
          && (sumBorrowRewardApr(liability, viewer.value, collateralAddress) > 0
            || loopingRewards > 0
            || collateralLendCampaigns.some(
              c => c.action === 'LEND' && typeof c.apr === 'number' && c.apr > 0,
            ))

        const netApy = supplyFinal - borrowFinal + loopingRewards
        if (netApy > fallback) {
          fallback = netApy
          fallbackHasRewards = supplyHasRewards
          fallbackPair = `${getVaultAssetSymbol(collateral)}/${liability.asset.symbol}`
          fallbackSupplyAPY = supplyFinal
          fallbackBorrowAPY = borrowFinal
          fallbackBorrowVaultAddress = liability.address
          fallbackCollateralAddress = collateralAddress
        }

        if (!areTokenAddressesCorrelatedByTags(getVaultAssetAddress(collateral), liability.asset.address, address => getTokenCategoryTags(address, liability.chainId))) continue

        if (roe > best) {
          best = roe
          bestHasRewards = supplyHasRewards
          bestPair = `${getVaultAssetSymbol(collateral)}/${liability.asset.symbol}`
          bestMultiplier = maxMultiplier
          bestSupplyAPY = supplyFinal
          bestBorrowAPY = borrowFinal
          bestBorrowLTV = ltvToPercent(ltv.borrowLTV)
          bestBorrowVaultAddress = liability.address
          bestCollateralAddress = collateralAddress
        }
      }
    }

    if (!(Number.isFinite(best) && best > -Infinity) && Number.isFinite(fallback) && fallback > -Infinity) {
      return {
        value: fallback,
        metric: 'net-apy',
        hasRewards: fallbackHasRewards,
        pair: fallbackPair,
        maxMultiplier: 1,
        supplyAPY: fallbackSupplyAPY,
        borrowAPY: fallbackBorrowAPY,
        borrowLTV: 0,
        borrowVaultAddress: fallbackBorrowVaultAddress,
        collateralAddress: fallbackCollateralAddress,
      }
    }

    const value = Number.isFinite(best) && best > -Infinity ? best : 0
    return {
      value,
      metric: 'max-roe',
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
    metric: 'max-roe',
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
