<script setup lang="ts">
import { type AnyBorrowVaultPair, getCurrentLiquidationLTV, isLiquidationLTVRamping } from '~/entities/vault'
import { isAnyVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { isVaultDeprecated } from '~/utils/eulerLabelsUtils'
import { getCollateralOraclePrice, getAssetOraclePrice } from '~/services/pricing/priceProvider'
import { formatNumber, formatSignificant } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { getMaxMultiplier, getMaxRoe } from '~/utils/leverage'
import type { AccountBorrowPosition } from '~/entities/account'
import type { LTVRampConfig } from '~/entities/vault/ltv'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultNetApyPairModal, VaultMaxRoeModal, VaultRampDownModal } from '#components'

const { pair } = defineProps<{ pair: AnyBorrowVaultPair | AccountBorrowPosition }>()

const hasRampConfig = computed(() => 'initialLiquidationLTV' in pair)
const currentLiquidationLTV = computed(() =>
  hasRampConfig.value ? getCurrentLiquidationLTV(pair as AnyBorrowVaultPair) : pair.liquidationLTV,
)
const isRamping = computed(() =>
  hasRampConfig.value && isLiquidationLTVRamping(pair as AnyBorrowVaultPair),
)

const modal = useModal()
const { withIntrinsicBorrowApy, withIntrinsicSupplyApy, getIntrinsicApy } = useIntrinsicApy()
const { getSupplyRewardApy, getBorrowRewardApy, getLoopingRewardApy, getSupplyRewardCampaigns, getBorrowRewardCampaigns, getLoopingRewardCampaigns, hasSupplyRewards, hasBorrowRewards, hasLoopingRewards } = useRewardsApy()
const { borrowList } = useVaults()

const borrowCount = computed(() => {
  return borrowList.value.filter(p => p.borrow.address === pair.borrow.address).length
})

const isBorrowable = computed(() => borrowCount.value > 0)
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

const onNetApyInfoIconClick = () => {
  modal.open(VaultNetApyPairModal, {
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
  })
}

const onMaxRoeInfoIconClick = () => {
  modal.open(VaultMaxRoeModal, {
    props: {
      maxRoe: maxRoe.value,
      maxMultiplier: maxMultiplier.value,
      supplyAPY: supplyApyWithRewards.value,
      borrowAPY: borrowApyWithRewards.value,
      borrowLTV: nanoToValue(pair.borrowLTV, 2),
      borrowVaultAddress: pair.borrow.address,
      collateralAddress: pair.collateral.address,
    },
  })
}

const onRampDownInfoIconClick = (event: MouseEvent, pair: LTVRampConfig) => {
  modal.open(VaultRampDownModal, {
    props: pair,
  })
}
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
              Net APY
              <SvgIcon
                class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
                name="info-circle"
                @click="onNetApyInfoIconClick"
              />
            </span>
          </template>
          <span class="flex items-center gap-4">
            <SvgIcon
              v-if="hasSupplyRewards(pair.collateral.address) || hasBorrowRewards(pair.borrow.address, pair.collateral.address) || hasLoopingRewards(pair.borrow.address, pair.collateral.address)"
              class="!w-20 !h-20 text-accent-500 cursor-pointer"
              name="sparks"
              @click="onNetApyInfoIconClick"
            />
            {{ formatNumber(netApy) }}%
          </span>
        </VaultOverviewLabelValue>
        <VaultOverviewLabelValue v-if="isBorrowable">
          <template #label>
            <span class="flex items-center gap-4">
              Max ROE
              <SvgIcon
                class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
                name="info-circle"
                @click="onMaxRoeInfoIconClick"
              />
            </span>
          </template>
          <span class="flex items-center gap-4">
            <SvgIcon
              v-if="hasSupplyRewards(pair.collateral.address) || hasBorrowRewards(pair.borrow.address, pair.collateral.address) || hasLoopingRewards(pair.borrow.address, pair.collateral.address)"
              class="!w-20 !h-20 text-accent-500 cursor-pointer"
              name="sparks"
              @click="onMaxRoeInfoIconClick"
            />
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
              <SvgIcon
                v-if="isRamping"
                class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
                name="info-circle"
                @click.stop.prevent="onRampDownInfoIconClick($event, pair as AnyBorrowVaultPair)"
              />
            </span>
          </template>
          <span class="flex items-center gap-4">
            <SvgIcon
              v-if="isRamping"
              name="arrow-top-right"
              class="!w-14 !h-14 text-warning-500 shrink-0 rotate-180 cursor-pointer"
              title="Liquidation LTV ramping down"
              @click.stop.prevent="onRampDownInfoIconClick($event, pair as AnyBorrowVaultPair)"
            />
            {{ `${formatNumber(nanoToValue(currentLiquidationLTV, 2), 2)}%` }}
          </span>
        </VaultOverviewLabelValue>
      </div>
    </div>
  </div>
</template>
