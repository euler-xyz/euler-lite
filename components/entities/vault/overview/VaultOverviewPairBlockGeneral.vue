<script setup lang="ts">
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
import { VaultNetApyPairModal, VaultMaxRoeModal, VaultRampDownModal, VaultSupplyApyModal, VaultBorrowApyModal, UiModalPreviewTrigger } from '#components'

const { pair } = defineProps<{ pair: AnyBorrowVaultPair | PortfolioBorrowPosition<VaultEntity> }>()

const borrowVault = computed(() => getPairBorrowVault(pair))
const collateralVault = computed(() => getPairCollateralVault(pair))
const pairBorrowLTV = computed(() => getPairBorrowLTV(pair))
const pairBorrowLTVPercent = computed(() =>
  pairBorrowLTV.value === undefined ? null : ltvToPercent(pairBorrowLTV.value),
)
const rampConfig = computed(() => getPairRampConfig(pair))
const currentLiquidationLTV = computed(() => getPairCurrentLiquidationLTV(pair))
const currentLiquidationLTVPercent = computed(() =>
  currentLiquidationLTV.value === undefined ? null : ltvToPercent(currentLiquidationLTV.value),
)
const isRamping = computed(() =>
  !!rampConfig.value && rampConfig.value.isLiquidationLTVRamping,
)

const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { getSupplyRewardApy, getBorrowRewardApy, getLoopingRewardApy, getSupplyRewardCampaigns, getBorrowRewardCampaigns, getLoopingRewardCampaigns, hasSupplyRewards, hasBorrowRewards, hasLoopingRewards } = useRewardsApy()

const isBorrowable = computed(() => borrowVault.value.isBorrowable)
const isRestricted = computed(() => isAnyVaultBlockedByCountry(collateralVault.value.address, borrowVault.value.address))
const isDeprecated = computed(() => isVaultDeprecated(collateralVault.value.address) || isVaultDeprecated(borrowVault.value.address))

const collateralRewardAPY = computed(() => getSupplyRewardApy(collateralVault.value.address))
const borrowRewardAPY = computed(() => getBorrowRewardApy(borrowVault.value.address, collateralVault.value.address))
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

const loopingRewardAPY = computed(() => getLoopingRewardApy(borrowVault.value.address, collateralVault.value.address))
const maxMultiplier = computed(() => pairBorrowLTV.value === undefined ? 1 : getMaxMultiplier(pairBorrowLTV.value))
const netApy = computed(() => supplyApyWithRewards.value - borrowApyWithRewards.value + loopingRewardAPY.value)
const maxRoe = computed(() =>
  getMaxRoe(maxMultiplier.value, supplyApyWithRewards.value, borrowApyWithRewards.value, loopingRewardAPY.value),
)

const baseSupplyApy = computed(() => getVaultSupplyApy(collateralVault.value))
const baseBorrowApy = computed(() => getVaultBorrowApy(borrowVault.value))
const intrinsicSupplyApy = computed(() => getVaultIntrinsicApy(collateralVault.value, enableIntrinsicApy.value))
const intrinsicBorrowApy = computed(() => getVaultIntrinsicApy(borrowVault.value, enableIntrinsicApy.value))

const supplyCampaignsForModal = computed(() => getSupplyRewardCampaigns(collateralVault.value.address))
const borrowCampaignsForModal = computed(() => getBorrowRewardCampaigns(borrowVault.value.address, collateralVault.value.address))
const loopingCampaignsForModal = computed(() => getLoopingRewardCampaigns(borrowVault.value.address, collateralVault.value.address))

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

const availableLiquidityDisplay = ref({ amount: '-', symbol: '', usd: '' })
const formatLiquidityAmount = (amount: number) => {
  if (!Number.isFinite(amount)) return '-'
  if (Math.abs(amount) >= 10_000) return compactNumber(amount, 2, 0)
  return formatNumber(amount, 1, 0)
}

watchEffect(async () => {
  const liquidity = getVaultAvailableLiquidity(borrowVault.value)
  const price = await formatAssetValue(liquidity, borrowVault.value, 'off-chain')
  availableLiquidityDisplay.value = {
    amount: price.hasPrice ? formatLiquidityAmount(price.assetAmount) : price.display,
    symbol: price.hasPrice ? price.assetSymbol : '',
    usd: price.hasPrice ? formatCompactUsdValue(price.usdValue) : '',
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
</script>

<template>
  <div class="bg-surface-secondary rounded-xl flex flex-col gap-20 p-20 shadow-card">
    <p class="text-h3 text-content-primary">
      Overview
    </p>
    <div class="flex flex-col gap-16">
      <div
        v-if="isDeprecated"
        class="w-full rounded-12 p-16 bg-warning-100 text-warning-500"
      >
        <div class="flex items-center gap-8">
          <SvgIcon
            name="warning"
            class="!w-20 !h-20 flex-shrink-0"
          />
          <p class="text-p3 text-warning-500">
            One or more vaults in this pair have been deprecated.
          </p>
        </div>
      </div>
      <div
        v-if="isRestricted"
        class="w-full rounded-12 p-16 bg-warning-100 text-warning-500"
      >
        <div class="flex items-center gap-8">
          <SvgIcon
            name="warning"
            class="!w-20 !h-20 flex-shrink-0"
          />
          <p class="text-p3 text-warning-500">
            This vault is not available in your region.
          </p>
        </div>
      </div>
      <div class="grid grid-cols-1 laptop:grid-cols-8 gap-x-32 gap-y-16">
        <div class="flex flex-col gap-6 laptop:col-span-2">
          <div class="text-p3 text-content-tertiary">
            Price
          </div>
          <div class="text-p2 font-semibold text-content-primary">
            <template v-if="price !== null">
              {{ formatSignificant(priceInvert.invertValue(price), 4) }}
              <span class="mt-2 flex items-center gap-4 text-p3 font-normal text-content-tertiary">
                {{ priceInvert.displaySymbol }}
                <button
                  type="button"
                  aria-label="Invert price display"
                  class="text-content-tertiary hover:text-content-primary transition-colors inline-flex"
                  @click.stop="priceInvert.toggle"
                >
                  <SvgIcon
                    name="swap-horizontal"
                    class="!w-14 !h-14"
                  />
                </button>
              </span>
            </template>
            <template v-else>
              <span class="flex items-center text-warning-500">
                <SvgIcon
                  name="warning"
                  class="mr-4 !w-20 !h-20"
                />
                Unknown
              </span>
            </template>
          </div>
        </div>
        <div class="flex flex-col gap-6 laptop:col-span-2">
          <div class="text-p3 text-content-tertiary">
            Available liquidity
          </div>
          <div class="flex flex-col gap-2">
            <div class="flex items-baseline gap-4 text-p2 font-semibold text-content-primary">
              {{ availableLiquidityDisplay.amount }}
              <span
                v-if="availableLiquidityDisplay.symbol"
                class="text-p3 text-content-tertiary"
              >
                {{ availableLiquidityDisplay.symbol }}
              </span>
            </div>
            <div
              v-if="availableLiquidityDisplay.usd"
              class="text-p3 text-content-muted"
            >
              {{ availableLiquidityDisplay.usd }}
            </div>
          </div>
        </div>
        <div class="grid grid-cols-2 gap-x-16 laptop:col-span-4">
          <div class="flex flex-col gap-6">
            <div class="text-p3 text-content-tertiary">
              Max LTV
            </div>
            <div class="text-p2 font-semibold text-content-primary">
              {{ pairBorrowLTVPercent === null ? '-' : `${formatNumber(pairBorrowLTVPercent, 2)}%` }}
            </div>
          </div>
          <div class="flex flex-col gap-6">
            <div class="flex items-center gap-4 text-p3 text-content-tertiary">
              Liquidation LTV
              <UiModalPreviewTrigger
                v-if="isRamping"
                :component="VaultRampDownModal"
                :modal-data="rampDownModalData"
                aria-label="Show liquidation LTV ramp-down details"
              >
                <SvgIcon
                  class="!w-18 !h-18 text-content-muted cursor-pointer hover:text-content-secondary"
                  name="info-circle"
                />
              </UiModalPreviewTrigger>
            </div>
            <div class="flex items-center gap-4 text-p2 font-semibold text-content-primary">
              <UiModalPreviewTrigger
                v-if="isRamping"
                :component="VaultRampDownModal"
                :modal-data="rampDownModalData"
                aria-label="Show liquidation LTV ramp-down details"
              >
                <SvgIcon
                  name="arrow-top-right"
                  class="!w-14 !h-14 text-warning-500 shrink-0 rotate-180 cursor-pointer"
                />
              </UiModalPreviewTrigger>
              {{ currentLiquidationLTVPercent === null ? '-' : `${formatNumber(currentLiquidationLTVPercent, 2)}%` }}
            </div>
          </div>
        </div>

        <div class="h-px bg-line-subtle my-4 laptop:col-span-8" />

        <div class="flex items-center gap-8 text-h6 uppercase text-content-secondary laptop:col-span-8">
          <SvgIcon
            name="arrow-big"
            class="!w-16 !h-16"
          />
          Borrow
        </div>

        <div class="grid grid-cols-1 laptop:grid-cols-8 gap-x-32 gap-y-16 laptop:col-span-8">
          <div class="flex flex-col gap-6 laptop:col-span-2">
            <div class="flex items-center gap-4 text-p3 text-content-tertiary">
              Borrow APY
              <UiModalPreviewTrigger
                :component="VaultBorrowApyModal"
                :modal-data="borrowApyModalData"
                aria-label="Show borrow APY breakdown"
              >
                <SvgIcon
                  class="!w-18 !h-18 text-content-muted cursor-pointer hover:text-content-secondary"
                  name="info-circle"
                  data-modal-trigger="borrow-apy"
                />
              </UiModalPreviewTrigger>
            </div>
            <div class="flex items-center gap-4 text-p2 font-semibold text-content-primary">
              <UiModalPreviewTrigger
                v-if="hasBorrowRewards(borrowVault.address, collateralVault.address)"
                :component="VaultBorrowApyModal"
                :modal-data="borrowApyModalData"
                aria-label="Show borrow APY rewards breakdown"
              >
                <SvgIcon
                  class="!w-20 !h-20 text-accent-500 cursor-pointer"
                  name="sparks"
                  data-modal-trigger="borrow-apy"
                />
              </UiModalPreviewTrigger>
              {{ formatNumber(borrowApyWithRewards) }}%
            </div>
          </div>

          <div class="flex flex-col gap-6 laptop:col-span-2">
            <div class="flex items-center gap-4 text-p3 text-content-tertiary">
              Collateral APY
              <UiModalPreviewTrigger
                :component="VaultSupplyApyModal"
                :modal-data="supplyApyModalData"
                aria-label="Show collateral APY breakdown"
              >
                <SvgIcon
                  class="!w-18 !h-18 text-content-muted cursor-pointer hover:text-content-secondary"
                  name="info-circle"
                  data-modal-trigger="supply-apy"
                />
              </UiModalPreviewTrigger>
            </div>
            <div class="flex items-center gap-4 text-p2 font-semibold text-content-primary">
              <VaultPoints :vault="collateralVault" />
              <UiModalPreviewTrigger
                v-if="hasSupplyRewards(collateralVault.address)"
                :component="VaultSupplyApyModal"
                :modal-data="supplyApyModalData"
                aria-label="Show collateral APY rewards breakdown"
              >
                <SvgIcon
                  class="!w-20 !h-20 text-accent-500 cursor-pointer"
                  name="sparks"
                  data-modal-trigger="supply-apy"
                />
              </UiModalPreviewTrigger>
              {{ formatNumber(supplyApyWithRewards) }}%
            </div>
          </div>

          <div class="flex flex-col gap-6 laptop:col-span-2">
            <div class="flex items-center gap-4 text-p3 text-content-tertiary">
              Net APY
              <UiModalPreviewTrigger
                :component="VaultNetApyPairModal"
                :modal-data="netApyModalData"
                aria-label="Show net APY breakdown"
              >
                <SvgIcon
                  class="!w-18 !h-18 text-content-muted cursor-pointer hover:text-content-secondary"
                  name="info-circle"
                  data-modal-trigger="net-apy"
                />
              </UiModalPreviewTrigger>
            </div>
            <div class="flex items-center gap-4 text-p2 font-semibold text-content-primary">
              <UiModalPreviewTrigger
                v-if="hasSupplyRewards(collateralVault.address) || hasBorrowRewards(borrowVault.address, collateralVault.address) || hasLoopingRewards(borrowVault.address, collateralVault.address)"
                :component="VaultNetApyPairModal"
                :modal-data="netApyModalData"
                aria-label="Show net APY rewards breakdown"
              >
                <SvgIcon
                  class="!w-20 !h-20 text-accent-500 cursor-pointer"
                  name="sparks"
                  data-modal-trigger="net-apy"
                />
              </UiModalPreviewTrigger>
              {{ formatNumber(netApy) }}%
            </div>
          </div>
        </div>

        <div
          v-if="isBorrowable"
          class="h-px bg-line-subtle my-4 laptop:col-span-8"
        />

        <div
          v-if="isBorrowable"
          class="flex items-center gap-8 text-h6 uppercase text-accent-500 laptop:col-span-8"
        >
          <SvgIcon
            name="multiply"
            class="!w-16 !h-16"
          />
          Multiply
        </div>

        <template v-if="isBorrowable">
          <div class="flex flex-col gap-6 laptop:col-span-2">
            <div class="text-p3 text-content-tertiary">
              Max multiplier
            </div>
            <div class="text-p2 font-semibold text-content-primary">
              {{ pairBorrowLTVPercent === null ? '-' : `${formatNumber(maxMultiplier, 2, 2)}x` }}
            </div>
          </div>

          <div class="flex flex-col gap-6 laptop:col-span-2">
            <div class="flex items-center gap-4 text-p3 text-content-tertiary">
              Max ROE
              <UiModalPreviewTrigger
                :component="VaultMaxRoeModal"
                :modal-data="maxRoeModalData"
                aria-label="Show max ROE breakdown"
              >
                <SvgIcon
                  class="!w-18 !h-18 text-content-muted cursor-pointer hover:text-content-secondary"
                  name="info-circle"
                  data-modal-trigger="max-roe"
                />
              </UiModalPreviewTrigger>
            </div>
            <div class="flex items-center gap-4 text-p2 font-semibold text-content-primary">
              <UiModalPreviewTrigger
                v-if="hasSupplyRewards(collateralVault.address) || hasBorrowRewards(borrowVault.address, collateralVault.address) || hasLoopingRewards(borrowVault.address, collateralVault.address)"
                :component="VaultMaxRoeModal"
                :modal-data="maxRoeModalData"
                aria-label="Show max ROE rewards breakdown"
              >
                <SvgIcon
                  class="!w-20 !h-20 text-accent-500 cursor-pointer"
                  name="sparks"
                  data-modal-trigger="max-roe"
                />
              </UiModalPreviewTrigger>
              {{ formatNumber(maxRoe) }}%
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
