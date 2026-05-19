<script setup lang="ts">
import { type AnyBorrowVaultPair, getCurrentLiquidationLTV, isLiquidationLTVRamping } from '~/entities/vault'
import { isAnyVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { isVaultDeprecated } from '~/utils/eulerLabelsUtils'
import { getCollateralOraclePrice, getAssetOraclePrice } from '~/services/pricing/priceProvider'
import { formatNumber, formatSignificant } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { getMaxMultiplier, getMaxRoe } from '~/utils/leverage'
import { type AccountBorrowPosition, getPositionRampConfig } from '~/entities/account'
import type { LTVRampConfig } from '~/entities/vault/ltv'
import { VaultNetApyPairModal, VaultMaxRoeModal, VaultRampDownModal, VaultSupplyApyModal, VaultBorrowApyModal } from '#components'

const { pair } = defineProps<{ pair: AnyBorrowVaultPair | AccountBorrowPosition }>()

// `BorrowVaultPair` carries ramp fields flat on the pair, with `liquidationLTV`
// meaning the post-ramp target. `AccountBorrowPosition` exposes them via
// `targetLiquidationLTV` + friends — `position.liquidationLTV` is the live
// effective value from the lens. Normalise to a single `LTVRampConfig` shape
// here so the helpers and modal don't need to know which type they got.
const isAccountPosition = (p: typeof pair): p is AccountBorrowPosition => 'targetLiquidationLTV' in p
const rampConfig = computed<LTVRampConfig | null>(() => {
  if (isAccountPosition(pair)) {
    if (pair.rampDuration === 0n && pair.targetTimestamp === 0n) return null
    return getPositionRampConfig(pair)
  }
  if ('initialLiquidationLTV' in pair) return pair as LTVRampConfig
  return null
})
const currentLiquidationLTV = computed(() => {
  // For an account position the lens already gives the live effective value;
  // for a market pair we interpolate from the ramp config so the modal and the
  // row stay in sync as time advances.
  if (isAccountPosition(pair)) return pair.liquidationLTV
  if (rampConfig.value) return getCurrentLiquidationLTV(rampConfig.value)
  return pair.liquidationLTV
})
const isRamping = computed(() => !!rampConfig.value && isLiquidationLTVRamping(rampConfig.value))

const { withIntrinsicBorrowApy, withIntrinsicSupplyApy, getIntrinsicApy, getIntrinsicApyInfo } = useIntrinsicApy()
const { getSupplyRewardApy, getBorrowRewardApy, getLoopingRewardApy, getSupplyRewardCampaigns, getBorrowRewardCampaigns, getLoopingRewardCampaigns, hasSupplyRewards, hasBorrowRewards, hasLoopingRewards } = useRewardsApy()

// On a borrow pair detail page the pair only exists because the on-chain
// collateralLTV has a non-zero borrowLTV — gate on that directly so deep links
// to unverified (off-label) pairs render the borrow-side metrics. Sourcing this
// from `useVaults().borrowList` would skip pairs whose borrow vault isn't in
// the labels repo.
const isBorrowable = computed(() => pair.borrowLTV > 0n)
const isRestricted = computed(() => isAnyVaultBlockedByCountry(pair.collateral.address, pair.borrow.address))
const isDeprecated = computed(() => isVaultDeprecated(pair.collateral.address) || isVaultDeprecated(pair.borrow.address))

const collateralRewardAPY = computed(() => getSupplyRewardApy(pair.collateral.address))
const borrowRewardAPY = computed(() => getBorrowRewardApy(pair.borrow.address, pair.collateral.address))
const supplyApyWithRewards = computed(() => withIntrinsicSupplyApy(
  nanoToValue(pair.collateral.interestRateInfo.supplyAPY, 25),
  pair.collateral.asset.address,
) + collateralRewardAPY.value)
const borrowApyWithRewards = computed(() => withIntrinsicBorrowApy(
  nanoToValue(pair.borrow.interestRateInfo.borrowAPY, 25),
  pair.borrow.asset.address,
) - borrowRewardAPY.value)

const loopingRewardAPY = computed(() => getLoopingRewardApy(pair.borrow.address, pair.collateral.address))
const maxMultiplier = computed(() => getMaxMultiplier(pair.borrowLTV))
const netApy = computed(() => supplyApyWithRewards.value - borrowApyWithRewards.value + loopingRewardAPY.value)
const maxRoe = computed(() =>
  getMaxRoe(maxMultiplier.value, supplyApyWithRewards.value, borrowApyWithRewards.value, loopingRewardAPY.value),
)

const baseSupplyApy = computed(() => nanoToValue(pair.collateral.interestRateInfo.supplyAPY, 25))
const baseBorrowApy = computed(() => nanoToValue(pair.borrow.interestRateInfo.borrowAPY, 25))
const intrinsicSupplyApy = computed(() => getIntrinsicApy(pair.collateral.asset.address))
const intrinsicBorrowApy = computed(() => getIntrinsicApy(pair.borrow.asset.address))

const supplyCampaignsForModal = computed(() => getSupplyRewardCampaigns(pair.collateral.address))
const borrowCampaignsForModal = computed(() => getBorrowRewardCampaigns(pair.borrow.address, pair.collateral.address))
const loopingCampaignsForModal = computed(() => getLoopingRewardCampaigns(pair.borrow.address, pair.collateral.address))

const priceInvert = usePriceInvert(
  () => pair.collateral.asset.symbol,
  () => pair.borrow.asset.symbol,
)

const price = computed(() => {
  const collateralPrice = getCollateralOraclePrice(pair.borrow, pair.collateral)
  const borrowPrice = getAssetOraclePrice(pair.borrow)

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
  props: rampConfig.value ?? {},
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
          :value="`${formatNumber(maxMultiplier, 2, 2)}x`"
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
            <VaultPoints :vault="pair.collateral" />
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
          :value="`${formatNumber(nanoToValue(pair.borrowLTV, 2), 2)}%`"
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
