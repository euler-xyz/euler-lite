<script setup lang="ts">
import type { AnyBorrowVaultPair } from '~/types/borrow-pair'
import type { EVaultCollateral, PortfolioBorrowPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import { isAnyVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { isVaultDeprecated } from '~/utils/eulerLabelsUtils'
import { getCollateralOraclePrice, getAssetOraclePrice } from '~/utils/sdk-prices'
import { formatNumber, formatSignificant } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { getMaxMultiplier, getMaxRoe } from '~/utils/leverage'
import type { AccountBorrowPosition } from '~/entities/account'
import { VaultNetApyPairModal, VaultMaxRoeModal, VaultRampDownModal, VaultSupplyApyModal, VaultBorrowApyModal } from '#components'

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

const { withIntrinsicBorrowApy, withIntrinsicSupplyApy, getIntrinsicApy, getIntrinsicApyInfo } = useIntrinsicApy()
const { getSupplyRewardApy, getBorrowRewardApy, getLoopingRewardApy, getSupplyRewardCampaigns, getBorrowRewardCampaigns, getLoopingRewardCampaigns, hasSupplyRewards, hasBorrowRewards, hasLoopingRewards } = useRewardsApy()

const isBorrowable = computed(() => borrowVault.value.isBorrowable)
const isRestricted = computed(() => isAnyVaultBlockedByCountry(collateralVault.value.address, borrowVault.value.address))
const isDeprecated = computed(() => isVaultDeprecated(collateralVault.value.address) || isVaultDeprecated(borrowVault.value.address))

const collateralRewardAPY = computed(() => getSupplyRewardApy(collateralVault.value.address))
const borrowRewardAPY = computed(() => getBorrowRewardApy(borrowVault.value.address, collateralVault.value.address))
const supplyApyWithRewards = computed(() => withIntrinsicSupplyApy(
  getVaultSupplyApy(collateralVault.value),
  collateralVault.value.asset.address,
) + collateralRewardAPY.value)
const borrowApyWithRewards = computed(() => withIntrinsicBorrowApy(
  getVaultBorrowApy(borrowVault.value),
  borrowVault.value.asset.address,
) - borrowRewardAPY.value)

const loopingRewardAPY = computed(() => getLoopingRewardApy(borrowVault.value.address, collateralVault.value.address))
const maxMultiplier = computed(() => pairBorrowLTV.value === undefined ? 1 : getMaxMultiplier(pairBorrowLTV.value))
const netApy = computed(() => supplyApyWithRewards.value - borrowApyWithRewards.value + loopingRewardAPY.value)
const maxRoe = computed(() =>
  getMaxRoe(maxMultiplier.value, supplyApyWithRewards.value, borrowApyWithRewards.value, loopingRewardAPY.value),
)

const baseSupplyApy = computed(() => getVaultSupplyApy(collateralVault.value))
const baseBorrowApy = computed(() => getVaultBorrowApy(borrowVault.value))
const intrinsicSupplyApy = computed(() => getIntrinsicApy(collateralVault.value.asset.address))
const intrinsicBorrowApy = computed(() => getIntrinsicApy(borrowVault.value.asset.address))

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

  // Check for 0n in denominator to prevent division by zero
  if (!collateralPrice || !borrowPrice || borrowPrice.amountOutMid === 0n) {
    return null
  }

  return nanoToValue(collateralPrice.amountOutMid, 18) / nanoToValue(borrowPrice.amountOutMid, 18)
})

const supplyApyModalData = computed(() => ({
  props: {
    lendingAPY: baseSupplyApy.value,
    intrinsicAPY: intrinsicSupplyApy.value,
    intrinsicApyInfo: getIntrinsicApyInfo(pair.collateral.asset.address),
    campaigns: supplyCampaignsForModal.value,
  },
}))

const borrowApyModalData = computed(() => ({
  props: {
    borrowingAPY: baseBorrowApy.value,
    intrinsicAPY: intrinsicBorrowApy.value,
    intrinsicApyInfo: getIntrinsicApyInfo(pair.borrow.asset.address),
    campaigns: borrowCampaignsForModal.value,
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
    borrowLTV: nanoToValue(pair.borrowLTV, 2),
    borrowVaultAddress: pair.borrow.address,
    collateralAddress: pair.collateral.address,
  },
}))

const rampDownModalData = computed(() => ({
  props: pair,
}))
</script>

<template>
  <div class="bg-surface-secondary rounded-xl flex flex-col gap-24 p-24 shadow-card">
    <p class="text-h3 text-content-primary">
      Overview
    </p>
    <div class="flex flex-col gap-20">
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
      <div class="grid grid-cols-2 gap-x-32 gap-y-24">
        <VaultOverviewLabelValue label="Price">
          <template v-if="price !== null">
            {{ formatSignificant(priceInvert.invertValue(price), 4) }}
            <span class="text-content-tertiary">{{ priceInvert.displaySymbol }}</span>
            <button
              type="button"
              aria-label="Invert price display"
              class="ml-4 text-content-tertiary hover:text-content-primary transition-colors inline-flex"
              @click.stop="priceInvert.toggle"
            >
              <SvgIcon
                name="swap-horizontal"
                class="!w-12 !h-12"
              />
            </button>
          </template>
          <template v-else>
            <span class="flex items-center text-warning-500">
              <SvgIcon
                name="warning"
                class="mr-2 !w-20 !h-20"
              />
              Unknown
            </span>
          </template>
        </VaultOverviewLabelValue>
        <VaultOverviewLabelValue
          v-if="isBorrowable"
          label="Max multiplier"
          :value="pairBorrowLTVPercent === null ? '-' : `${formatNumber(maxMultiplier, 2, 2)}x`"
        />
        <VaultOverviewLabelValue>
          <template #label>
            <span class="flex items-center gap-4">
              Supply APY
              <UiModalPreviewTrigger
                :component="VaultSupplyApyModal"
                :modal-data="supplyApyModalData"
                aria-label="Show supply APY breakdown"
              >
                <SvgIcon
                  class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
                  name="info-circle"
                />
              </UiModalPreviewTrigger>
            </span>
          </template>
          <span class="flex items-center gap-4">
            <UiModalPreviewTrigger
              v-if="hasSupplyRewards(pair.collateral.address)"
              :component="VaultSupplyApyModal"
              :modal-data="supplyApyModalData"
              aria-label="Show supply APY rewards breakdown"
            >
              <SvgIcon
                class="!w-20 !h-20 text-accent-500 cursor-pointer"
                name="sparks"
              />
            </UiModalPreviewTrigger>
            {{ formatNumber(supplyApyWithRewards) }}%
          </span>
        </VaultOverviewLabelValue>
        <VaultOverviewLabelValue>
          <template #label>
            <span class="flex items-center gap-4">
              Borrow APY
              <UiModalPreviewTrigger
                :component="VaultBorrowApyModal"
                :modal-data="borrowApyModalData"
                aria-label="Show borrow APY breakdown"
              >
                <SvgIcon
                  class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
                  name="info-circle"
                />
              </UiModalPreviewTrigger>
            </span>
          </template>
          <span class="flex items-center gap-4">
            <UiModalPreviewTrigger
              v-if="hasBorrowRewards(pair.borrow.address, pair.collateral.address)"
              :component="VaultBorrowApyModal"
              :modal-data="borrowApyModalData"
              aria-label="Show borrow APY rewards breakdown"
            >
              <SvgIcon
                class="!w-20 !h-20 text-accent-500 cursor-pointer"
                name="sparks"
              />
            </UiModalPreviewTrigger>
            {{ formatNumber(borrowApyWithRewards) }}%
          </span>
        </VaultOverviewLabelValue>
        <VaultOverviewLabelValue>
          <template #label>
            <span class="flex items-center gap-4">
              Net APY
              <UiModalPreviewTrigger
                :component="VaultNetApyPairModal"
                :modal-data="netApyModalData"
                aria-label="Show net APY breakdown"
              >
                <SvgIcon
                  class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
                  name="info-circle"
                />
              </UiModalPreviewTrigger>
            </span>
          </template>
          <span class="flex items-center gap-4">
            <UiModalPreviewTrigger
              v-if="hasSupplyRewards(pair.collateral.address) || hasBorrowRewards(pair.borrow.address, pair.collateral.address) || hasLoopingRewards(pair.borrow.address, pair.collateral.address)"
              :component="VaultNetApyPairModal"
              :modal-data="netApyModalData"
              aria-label="Show net APY rewards breakdown"
            >
              <SvgIcon
                class="!w-20 !h-20 text-accent-500 cursor-pointer"
                name="sparks"
              />
            </UiModalPreviewTrigger>
            {{ formatNumber(netApy) }}%
          </span>
        </VaultOverviewLabelValue>
        <VaultOverviewLabelValue v-if="isBorrowable">
          <template #label>
            <span class="flex items-center gap-4">
              Max ROE
              <UiModalPreviewTrigger
                :component="VaultMaxRoeModal"
                :modal-data="maxRoeModalData"
                aria-label="Show max ROE breakdown"
              >
                <SvgIcon
                  class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
                  name="info-circle"
                />
              </UiModalPreviewTrigger>
            </span>
          </template>
          <span class="flex items-center gap-4">
            <UiModalPreviewTrigger
              v-if="hasSupplyRewards(pair.collateral.address) || hasBorrowRewards(pair.borrow.address, pair.collateral.address) || hasLoopingRewards(pair.borrow.address, pair.collateral.address)"
              :component="VaultMaxRoeModal"
              :modal-data="maxRoeModalData"
              aria-label="Show max ROE rewards breakdown"
            >
              <SvgIcon
                class="!w-20 !h-20 text-accent-500 cursor-pointer"
                name="sparks"
              />
            </UiModalPreviewTrigger>
            {{ formatNumber(maxRoe) }}%
          </span>
        </VaultOverviewLabelValue>
        <VaultOverviewLabelValue
          label="Max LTV"
          :value="pairBorrowLTVPercent === null ? '-' : `${formatNumber(pairBorrowLTVPercent, 2)}%`"
        />
        <VaultOverviewLabelValue>
          <template #label>
            <span class="flex items-center gap-4">
              Liquidation LTV
              <UiModalPreviewTrigger
                v-if="isRamping"
                :component="VaultRampDownModal"
                :modal-data="rampDownModalData"
                aria-label="Show liquidation LTV ramp-down details"
              >
                <SvgIcon
                  class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
                  name="info-circle"
                />
              </UiModalPreviewTrigger>
            </span>
          </template>
          <span class="flex items-center gap-4">
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
            {{ `${formatNumber(nanoToValue(currentLiquidationLTV, 2), 2)}%` }}
          </span>
        </VaultOverviewLabelValue>
      </div>
    </div>
  </div>
</template>
