<script setup lang="ts">
import type { SecuritizeBorrowVaultPair } from '~/types/borrow-pair'
import { getAssetOraclePrice, getCollateralOraclePrice } from '~/utils/sdk-prices'
import { getMaxMultiplier, getMaxRoe } from '~/utils/leverage'
import { withVaultIntrinsicApy, getVaultIntrinsicApy, getVaultIntrinsicApyInfo } from '~/utils/vault-intrinsic-apy'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultBorrowApyModal, VaultRampDownModal, VaultSupplyApyModal, UiModalPreviewTrigger } from '#components'
import type { EVaultCollateral } from '@eulerxyz/euler-v2-sdk'
import { formatNumber, formatSignificant } from '~/utils/string-utils'
import { areTokenAddressesCorrelatedByTags } from '~/utils/token-categories'

const { pair } = defineProps<{ pair: SecuritizeBorrowVaultPair }>()
const { getTokenCategoryTags } = useTokenList()

const currentLiquidationLTV = computed(() => pair.ltv.currentLiquidationLTV)
const isRamping = computed(() => pair.ltv.isLiquidationLTVRamping)

const modal = useModal()
const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { getSupplyRewardApy, getBorrowRewardApy, getLoopingRewardApy, getSupplyRewardCampaigns, getBorrowRewardCampaigns, hasSupplyRewards, hasBorrowRewards } = useRewardsApy()

// Borrow APY (from EVault borrow vault)
const totalBorrowRewardsAPY = computed(() => getBorrowRewardApy(pair.borrow.address, pair.collateral.address))

const borrowApyWithRewards = computed(() => withVaultIntrinsicApy(
  getVaultBorrowApy(pair.borrow),
  pair.borrow,
  enableIntrinsicApy.value,
) - totalBorrowRewardsAPY.value)

const baseBorrowApy = computed(() => getVaultBorrowApy(pair.borrow))
const intrinsicBorrowApy = computed(() => getVaultIntrinsicApy(pair.borrow, enableIntrinsicApy.value))
const borrowRewardInfo = computed(() => getBorrowRewardCampaigns(pair.borrow.address, pair.collateral.address))

// Supply APY (for securitize collateral - intrinsic + rewards only, no interest rate)
const collateralRewardAPY = computed(() => getSupplyRewardApy(pair.collateral.address))
const intrinsicSupplyApy = computed(() => getVaultIntrinsicApy(pair.collateral, enableIntrinsicApy.value))
const supplyApyWithRewards = computed(() => intrinsicSupplyApy.value + collateralRewardAPY.value)
const supplyRewardInfo = computed(() => getSupplyRewardCampaigns(pair.collateral.address))

const loopingRewardAPY = computed(() => getLoopingRewardApy(pair.borrow.address, pair.collateral.address))
const maxMultiplier = computed(() => getMaxMultiplier(pair.ltv.borrowLTV))
const maxRoe = computed(() =>
  getMaxRoe(maxMultiplier.value, supplyApyWithRewards.value, borrowApyWithRewards.value, loopingRewardAPY.value),
)
const showMaxRoe = computed(() =>
  areTokenAddressesCorrelatedByTags(
    pair.collateral.asset.address,
    pair.borrow.asset.address,
    getTokenCategoryTags,
  ),
)

const priceInvert = usePriceInvert(
  () => pair.collateral.asset.symbol,
  () => pair.borrow.asset.symbol,
)

// Calculate collateral/borrow price through the borrow vault's collateral
// oracle route, then pair it with the borrow vault's own asset oracle price.
const price = computed(() => {
  const collateralPrice = getCollateralOraclePrice(pair.borrow, pair.collateral)
  const borrowPrice = getAssetOraclePrice(pair.borrow)

  const bid = collateralPrice?.amountOutBid || collateralPrice?.amountOutMid || 0n
  const ask = borrowPrice?.amountOutAsk || borrowPrice?.amountOutMid || 0n

  if (!bid || !ask || ask === 0n) return null
  return Number(bid) / Number(ask)
})

const supplyApyModalData = computed(() => ({
  props: {
    lendingAPY: 0, // Securitize vaults don't have interest rates
    intrinsicAPY: intrinsicSupplyApy.value,
    intrinsicApyInfo: getVaultIntrinsicApyInfo(pair.collateral, enableIntrinsicApy.value),
    campaigns: supplyRewardInfo.value,
    rewardVaultAddress: pair.collateral.address,
  },
}))

const borrowApyModalData = computed(() => ({
  props: {
    borrowingAPY: baseBorrowApy.value,
    intrinsicAPY: intrinsicBorrowApy.value,
    intrinsicApyInfo: getVaultIntrinsicApyInfo(pair.borrow, enableIntrinsicApy.value),
    campaigns: borrowRewardInfo.value,
    rewardVaultAddress: pair.borrow.address,
  },
}))

const onRampDownInfoIconClick = (event: MouseEvent, pair: EVaultCollateral) => {
  modal.open(VaultRampDownModal, {
    props: pair,
  })
}
</script>

<template>
  <div class="bg-body rounded-16 flex flex-col gap-24 p-24">
    <p class="text-h3 text-white">
      Overview
    </p>
    <div class="flex flex-col items-start gap-24">
      <VaultOverviewLabelValue
        label="Price"
      >
        <template v-if="price !== null">
          {{ formatSignificant(priceInvert.invertValue(price), 4) }}
          <span class="text-content-primary">{{ priceInvert.displaySymbol }}</span>
          <button
            type="button"
            class="ml-4 text-content-primary hover:text-white transition-colors inline-flex"
            @click.stop="priceInvert.toggle"
          >
            <SvgIcon
              name="swap-horizontal"
              class="!w-12 !h-12"
            />
          </button>
        </template>
        <template v-else>
          <span class="text-content-primary">-</span>
        </template>
      </VaultOverviewLabelValue>
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
                class="!w-20 !h-20 text-content-muted hover:text-content-secondary cursor-pointer"
                name="info-circle"
                data-modal-trigger="supply-apy"
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
              data-modal-trigger="supply-apy"
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
                class="!w-20 !h-20 text-content-muted hover:text-content-secondary cursor-pointer"
                name="info-circle"
                data-modal-trigger="borrow-apy"
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
              data-modal-trigger="borrow-apy"
            />
          </UiModalPreviewTrigger>
          {{ formatNumber(borrowApyWithRewards) }}%
        </span>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue
        v-if="showMaxRoe"
        label="Max ROE"
        :value="`${formatNumber(maxRoe, 2, 2)}%`"
      />
      <VaultOverviewLabelValue
        label="Max multiplier"
        :value="`${formatNumber(maxMultiplier, 2, 2)}x`"
      />
      <VaultOverviewLabelValue
        label="Max LTV"
        :value="`${formatNumber(ltvToPercent(pair.ltv.borrowLTV), 2)}%`"
      />
      <VaultOverviewLabelValue>
        <template #label>
          <span class="flex items-center gap-4">
            Liquidation LTV
            <SvgIcon
              v-if="isRamping"
              class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
              name="info-circle"
              @click.stop.prevent="onRampDownInfoIconClick($event, pair.ltv)"
            />
          </span>
        </template>
        <span class="flex items-center gap-4">
          <UiHoverPreviewTooltip
            v-if="isRamping"
            title="Liquidation LTV ramping down"
            text="The Liquidation LTV for this collateral is currently being reduced."
            placement="top-start"
          >
            <SvgIcon
              name="arrow-top-right"
              class="!w-14 !h-14 text-warning-500 shrink-0 rotate-180 cursor-pointer"
              @click.stop.prevent="onRampDownInfoIconClick($event, pair.ltv)"
            />
          </UiHoverPreviewTooltip>
          {{ `${formatNumber(ltvToPercent(currentLiquidationLTV), 2)}%` }}
        </span>
      </VaultOverviewLabelValue>
    </div>
  </div>
</template>
