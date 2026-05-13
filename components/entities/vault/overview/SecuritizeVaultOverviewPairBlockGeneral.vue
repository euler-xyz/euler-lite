<script setup lang="ts">
import { formatNumber, formatSignificant } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { type SecuritizeBorrowVaultPair, getCurrentLiquidationLTV, isLiquidationLTVRamping } from '~/entities/vault'
import { getAssetOraclePrice } from '~/services/pricing/priceProvider'
import { getMaxMultiplier, getMaxRoe } from '~/utils/leverage'
import { VaultBorrowApyModal, VaultRampDownModal, VaultSupplyApyModal } from '#components'

const { pair } = defineProps<{ pair: SecuritizeBorrowVaultPair }>()

const currentLiquidationLTV = computed(() => getCurrentLiquidationLTV(pair))
const isRamping = computed(() => isLiquidationLTVRamping(pair))

const { withIntrinsicBorrowApy, getIntrinsicApy, getIntrinsicApyInfo } = useIntrinsicApy()
const { getSupplyRewardApy, getBorrowRewardApy, getLoopingRewardApy, getSupplyRewardCampaigns, getBorrowRewardCampaigns, hasSupplyRewards, hasBorrowRewards } = useRewardsApy()

// Borrow APY (from EVK borrow vault)
const totalBorrowRewardsAPY = computed(() => getBorrowRewardApy(pair.borrow.address, pair.collateral.address))

const borrowApyWithRewards = computed(() => withIntrinsicBorrowApy(
  nanoToValue(pair.borrow.interestRateInfo.borrowAPY, 25),
  pair.borrow.asset.address,
) - totalBorrowRewardsAPY.value)

const baseBorrowApy = computed(() => nanoToValue(pair.borrow.interestRateInfo.borrowAPY, 25))
const intrinsicBorrowApy = computed(() => getIntrinsicApy(pair.borrow.asset.address))
const borrowRewardInfo = computed(() => getBorrowRewardCampaigns(pair.borrow.address, pair.collateral.address))

// Supply APY (for securitize collateral - intrinsic + rewards only, no interest rate)
const collateralRewardAPY = computed(() => getSupplyRewardApy(pair.collateral.address))
const intrinsicSupplyApy = computed(() => getIntrinsicApy(pair.collateral.asset.address))
const supplyApyWithRewards = computed(() => intrinsicSupplyApy.value + collateralRewardAPY.value)
const supplyRewardInfo = computed(() => getSupplyRewardCampaigns(pair.collateral.address))

const loopingRewardAPY = computed(() => getLoopingRewardApy(pair.borrow.address, pair.collateral.address))
const maxMultiplier = computed(() => getMaxMultiplier(pair.borrowLTV))
const maxRoe = computed(() =>
  getMaxRoe(maxMultiplier.value, supplyApyWithRewards.value, borrowApyWithRewards.value, loopingRewardAPY.value),
)

const priceInvert = usePriceInvert(
  () => pair.collateral.asset.symbol,
  () => pair.borrow.asset.symbol,
)

// Calculate price using collateral prices from borrow vault
const price = computed(() => {
  const collateralPrice = pair.borrow.collateralPrices.find(
    p => p.asset === pair.collateral.address,
  )
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
    intrinsicApyInfo: getIntrinsicApyInfo(pair.collateral.asset.address),
    campaigns: supplyRewardInfo.value,
  },
}))

const borrowApyModalData = computed(() => ({
  props: {
    borrowingAPY: baseBorrowApy.value,
    intrinsicAPY: intrinsicBorrowApy.value,
    intrinsicApyInfo: getIntrinsicApyInfo(pair.borrow.asset.address),
    campaigns: borrowRewardInfo.value,
  },
}))

const rampDownModalData = computed(() => ({
  props: pair,
}))
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
            <UiHoverModalTrigger
              :component="VaultSupplyApyModal"
              :modal-data="supplyApyModalData"
              aria-label="Show supply APY breakdown"
            >
              <SvgIcon
                class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
                name="info-circle"
              />
            </UiHoverModalTrigger>
          </span>
        </template>
        <span class="flex items-center gap-4">
          <UiHoverModalTrigger
            v-if="hasSupplyRewards(pair.collateral.address)"
            :component="VaultSupplyApyModal"
            :modal-data="supplyApyModalData"
            aria-label="Show supply APY rewards breakdown"
          >
            <SvgIcon
              class="!w-20 !h-20 text-accent-500 cursor-pointer"
              name="sparks"
            />
          </UiHoverModalTrigger>
          {{ formatNumber(supplyApyWithRewards) }}%
        </span>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue>
        <template #label>
          <span class="flex items-center gap-4">
            Borrow APY
            <UiHoverModalTrigger
              :component="VaultBorrowApyModal"
              :modal-data="borrowApyModalData"
              aria-label="Show borrow APY breakdown"
            >
              <SvgIcon
                class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
                name="info-circle"
              />
            </UiHoverModalTrigger>
          </span>
        </template>
        <span class="flex items-center gap-4">
          <UiHoverModalTrigger
            v-if="hasBorrowRewards(pair.borrow.address, pair.collateral.address)"
            :component="VaultBorrowApyModal"
            :modal-data="borrowApyModalData"
            aria-label="Show borrow APY rewards breakdown"
          >
            <SvgIcon
              class="!w-20 !h-20 text-accent-500 cursor-pointer"
              name="sparks"
            />
          </UiHoverModalTrigger>
          {{ formatNumber(borrowApyWithRewards) }}%
        </span>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue
        label="Max ROE"
        :value="`${formatNumber(maxRoe, 2, 2)}%`"
      />
      <VaultOverviewLabelValue
        label="Max multiplier"
        :value="`${formatNumber(maxMultiplier, 2, 2)}x`"
      />
      <VaultOverviewLabelValue
        label="Max LTV"
        :value="`${formatNumber(nanoToValue(pair.borrowLTV, 2), 2)}%`"
      />
      <VaultOverviewLabelValue>
        <template #label>
          <span class="flex items-center gap-4">
            Liquidation LTV
            <UiHoverModalTrigger
              v-if="isRamping"
              :component="VaultRampDownModal"
              :modal-data="rampDownModalData"
              aria-label="Show liquidation LTV ramp-down details"
            >
              <SvgIcon
                class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
                name="info-circle"
              />
            </UiHoverModalTrigger>
          </span>
        </template>
        <span class="flex items-center gap-4">
          <UiHoverModalTrigger
            v-if="isRamping"
            :component="VaultRampDownModal"
            :modal-data="rampDownModalData"
            aria-label="Show liquidation LTV ramp-down details"
          >
            <SvgIcon
              name="arrow-top-right"
              class="!w-14 !h-14 text-warning-500 shrink-0 rotate-180 cursor-pointer"
            />
          </UiHoverModalTrigger>
          {{ `${formatNumber(nanoToValue(currentLiquidationLTV, 2), 2)}%` }}
        </span>
      </VaultOverviewLabelValue>
    </div>
  </div>
</template>
