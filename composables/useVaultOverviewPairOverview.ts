import type { InjectionKey } from 'vue'
import type { PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import { isAnyVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { isVaultDeprecated } from '~/utils/eulerLabelsUtils'
import { getCollateralOraclePrice, getAssetOraclePrice, formatAssetValue } from '~/utils/sdk-prices'
import { withVaultIntrinsicApy, getVaultIntrinsicApy, getVaultIntrinsicApyInfo } from '~/utils/vault-intrinsic-apy'
import { formatNumber, formatSignificant, formatCompactUsdValue, compactNumber } from '~/utils/string-utils'
import { nanoToValue, ltvToPercent } from '~/utils/crypto-utils'
import { getMaxMultiplier, getMaxRoe } from '~/utils/leverage'
import {
  getPairBorrowLTV,
  getPairBorrowVault,
  getPairCollateralVault,
  getPairCurrentLiquidationLTV,
  getPairRampConfig,
} from '~/utils/borrow-pair'
import { getVaultAvailableLiquidity } from '~/utils/vault-display'

export type VaultOverviewPairInput = AnyBorrowVaultPair | PortfolioBorrowPosition<VaultEntity>

export const vaultOverviewPairOverviewKey: InjectionKey<
  ReturnType<typeof useVaultOverviewPairOverview>
> = Symbol('vaultOverviewPairOverview')

export function useVaultOverviewPairOverview(
  pair: MaybeRefOrGetter<VaultOverviewPairInput>,
) {
  const pairValue = computed(() => toValue(pair))
  const borrowVault = computed(() => getPairBorrowVault(pairValue.value))
  const collateralVault = computed(() => getPairCollateralVault(pairValue.value))
  const pairBorrowLTV = computed(() => getPairBorrowLTV(pairValue.value))
  const pairBorrowLTVPercent = computed(() =>
    pairBorrowLTV.value === undefined ? null : ltvToPercent(pairBorrowLTV.value),
  )
  const rampConfig = computed(() => getPairRampConfig(pairValue.value))
  const currentLiquidationLTV = computed(() => getPairCurrentLiquidationLTV(pairValue.value))
  const currentLiquidationLTVPercent = computed(() =>
    currentLiquidationLTV.value === undefined ? null : ltvToPercent(currentLiquidationLTV.value),
  )
  const isRamping = computed(() =>
    !!rampConfig.value && rampConfig.value.isLiquidationLTVRamping,
  )

  const { settings } = useUserSettings()
  const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
  const {
    getSupplyRewardApy,
    getBorrowRewardApy,
    getLoopingRewardApy,
    getSupplyRewardCampaigns,
    getBorrowRewardCampaigns,
    getLoopingRewardCampaigns,
    hasSupplyRewards,
    hasBorrowRewards,
    hasLoopingRewards,
  } = useRewardsApy()

  const showMultiplySection = computed(() => (pairBorrowLTV.value ?? 0) > 0)
  const isRestricted = computed(() =>
    isAnyVaultBlockedByCountry(collateralVault.value.address, borrowVault.value.address),
  )
  const isDeprecated = computed(() =>
    isVaultDeprecated(collateralVault.value.address) || isVaultDeprecated(borrowVault.value.address),
  )

  const collateralRewardAPY = computed(() => getSupplyRewardApy(collateralVault.value.address))
  const borrowRewardAPY = computed(() =>
    getBorrowRewardApy(borrowVault.value.address, collateralVault.value.address),
  )
  const supplyApyWithRewards = computed(() => withVaultIntrinsicApy(
    getVaultSupplyApy(collateralVault.value),
    collateralVault.value,
    enableIntrinsicApy.value,
  ) + collateralRewardAPY.value)
  const borrowApyWithRewards = computed(() => withVaultIntrinsicApy(
    getVaultBorrowApy(borrowVault.value),
    borrowVault.value,
    enableIntrinsicApy.value,
  ) - borrowRewardAPY.value)

  const loopingRewardAPY = computed(() =>
    getLoopingRewardApy(borrowVault.value.address, collateralVault.value.address),
  )
  const maxMultiplier = computed(() =>
    pairBorrowLTV.value === undefined ? 1 : getMaxMultiplier(pairBorrowLTV.value),
  )
  const netApy = computed(() =>
    supplyApyWithRewards.value - borrowApyWithRewards.value + loopingRewardAPY.value,
  )
  const maxRoe = computed(() =>
    getMaxRoe(
      maxMultiplier.value,
      supplyApyWithRewards.value,
      borrowApyWithRewards.value,
      loopingRewardAPY.value,
    ),
  )

  const baseSupplyApy = computed(() => getVaultSupplyApy(collateralVault.value))
  const baseBorrowApy = computed(() => getVaultBorrowApy(borrowVault.value))
  const intrinsicSupplyApy = computed(() =>
    getVaultIntrinsicApy(collateralVault.value, enableIntrinsicApy.value),
  )
  const intrinsicBorrowApy = computed(() =>
    getVaultIntrinsicApy(borrowVault.value, enableIntrinsicApy.value),
  )

  const supplyCampaignsForModal = computed(() => getSupplyRewardCampaigns(collateralVault.value.address))
  const borrowCampaignsForModal = computed(() =>
    getBorrowRewardCampaigns(borrowVault.value.address, collateralVault.value.address),
  )
  const loopingCampaignsForModal = computed(() =>
    getLoopingRewardCampaigns(borrowVault.value.address, collateralVault.value.address),
  )

  const priceInvert = usePriceInvert(
    () => collateralVault.value.asset.symbol,
    () => borrowVault.value.asset.symbol,
  )

  const price = computed(() => {
    const collateralPrice = getCollateralOraclePrice(borrowVault.value, collateralVault.value)
    const borrowPrice = getAssetOraclePrice(borrowVault.value)

    if (!collateralPrice || !borrowPrice || borrowPrice.amountOutMid === 0n) {
      return null
    }

    return nanoToValue(collateralPrice.amountOutMid, 18) / nanoToValue(borrowPrice.amountOutMid, 18)
  })

  const displayPrice = computed((): number | undefined => {
    if (price.value === null) return undefined
    return priceInvert.invertValue(price.value) ?? price.value
  })

  priceInvert.autoInvert(price)

  const availableLiquidityDisplay = ref({ amount: '-', symbol: '', usd: '' })
  const formatLiquidityAmount = (amount: number) => {
    if (!Number.isFinite(amount)) return '-'
    if (Math.abs(amount) >= 10_000) return compactNumber(amount, 2, 0)
    return formatNumber(amount, 1, 0)
  }

  watchEffect(async () => {
    const liquidity = getVaultAvailableLiquidity(borrowVault.value)
    const assetPrice = await formatAssetValue(liquidity, borrowVault.value, 'off-chain')
    availableLiquidityDisplay.value = {
      amount: assetPrice.hasPrice ? formatLiquidityAmount(assetPrice.assetAmount) : assetPrice.display,
      symbol: assetPrice.hasPrice ? assetPrice.assetSymbol : '',
      usd: assetPrice.hasPrice ? formatCompactUsdValue(assetPrice.usdValue) : '',
    }
  })

  const supplyApyModalData = computed(() => ({
    props: {
      lendingAPY: baseSupplyApy.value,
      intrinsicAPY: intrinsicSupplyApy.value,
      intrinsicApyInfo: getVaultIntrinsicApyInfo(collateralVault.value, enableIntrinsicApy.value),
      campaigns: supplyCampaignsForModal.value,
      rewardVaultAddress: collateralVault.value.address,
    },
  }))

  const borrowApyModalData = computed(() => ({
    props: {
      borrowingAPY: baseBorrowApy.value,
      intrinsicAPY: intrinsicBorrowApy.value,
      intrinsicApyInfo: getVaultIntrinsicApyInfo(borrowVault.value, enableIntrinsicApy.value),
      campaigns: borrowCampaignsForModal.value,
      rewardVaultAddress: borrowVault.value.address,
    },
  }))

  const netApyModalData = computed(() => ({
    props: {
      supplyAPY: baseSupplyApy.value,
      borrowAPY: baseBorrowApy.value,
      intrinsicSupplyAPY: intrinsicSupplyApy.value,
      intrinsicBorrowAPY: intrinsicBorrowApy.value,
      supplyRewardAPY: collateralRewardAPY.value || null,
      borrowRewardAPY: borrowRewardAPY.value || null,
      loopingRewardAPY: loopingRewardAPY.value || null,
      supplyCampaigns: supplyCampaignsForModal.value,
      borrowCampaigns: borrowCampaignsForModal.value,
      loopingCampaigns: loopingCampaignsForModal.value,
    },
  }))

  const maxRoeModalData = computed(() => ({
    props: {
      maxRoe: maxRoe.value,
      maxMultiplier: maxMultiplier.value,
      supplyAPY: supplyApyWithRewards.value,
      borrowAPY: borrowApyWithRewards.value,
      borrowLTV: pairBorrowLTVPercent.value ?? 0,
      borrowVaultAddress: borrowVault.value.address,
      collateralAddress: collateralVault.value.address,
    },
  }))

  const rampDownModalData = computed(() => ({
    props: rampConfig.value ?? {},
  }))

  return {
    borrowVault,
    collateralVault,
    pairBorrowLTVPercent,
    currentLiquidationLTVPercent,
    isRamping,
    showMultiplySection,
    isRestricted,
    isDeprecated,
    supplyApyWithRewards,
    borrowApyWithRewards,
    netApy,
    maxMultiplier,
    maxRoe,
    priceInvert,
    displayPrice,
    availableLiquidityDisplay,
    supplyApyModalData,
    borrowApyModalData,
    netApyModalData,
    maxRoeModalData,
    rampDownModalData,
    hasSupplyRewards,
    hasBorrowRewards,
    hasLoopingRewards,
    formatSignificant,
    formatNumber,
  }
}

export function useVaultOverviewPairOverviewContext() {
  const context = inject(vaultOverviewPairOverviewKey)
  if (!context) {
    throw new Error('useVaultOverviewPairOverviewContext must be used within VaultOverviewPair')
  }
  return context
}
