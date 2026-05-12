<script setup lang="ts">
import type { SecuritizeBorrowVaultPair } from '~/types/borrow-pair'
import { getAssetOraclePrice, getCollateralOraclePrice } from '~/utils/sdk-prices'
import { getMaxMultiplier, getMaxRoe } from '~/utils/leverage'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultBorrowApyModal, VaultRampDownModal, VaultSupplyApyModal } from '#components'
import type { EVaultCollateral } from '@eulerxyz/euler-v2-sdk'
import { formatNumber, formatSignificant } from '~/utils/string-utils'

const { pair } = defineProps<{ pair: SecuritizeBorrowVaultPair }>()

const currentLiquidationLTV = computed(() => pair.ltv.currentLiquidationLTV)
const isRamping = computed(() => pair.ltv.isLiquidationLTVRamping)

const modal = useModal()
const { withIntrinsicBorrowApy, getIntrinsicApy, getIntrinsicApyInfo } = useIntrinsicApy()
const { getSupplyRewardApy, getBorrowRewardApy, getLoopingRewardApy, getSupplyRewardCampaigns, getBorrowRewardCampaigns, hasSupplyRewards, hasBorrowRewards } = useRewardsApy()

// Borrow APY (from EVault borrow vault)
const totalBorrowRewardsAPY = computed(() => getBorrowRewardApy(pair.borrow.address, pair.collateral.address))

const borrowApyWithRewards = computed(() => withIntrinsicBorrowApy(
  getVaultBorrowApy(pair.borrow),
  pair.borrow.asset.address,
) - totalBorrowRewardsAPY.value)

const baseBorrowApy = computed(() => getVaultBorrowApy(pair.borrow))
const intrinsicBorrowApy = computed(() => getIntrinsicApy(pair.borrow.asset.address))
const borrowRewardInfo = computed(() => getBorrowRewardCampaigns(pair.borrow.address, pair.collateral.address))

// Supply APY (for securitize collateral - intrinsic + rewards only, no interest rate)
const collateralRewardAPY = computed(() => getSupplyRewardApy(pair.collateral.address))
const intrinsicSupplyApy = computed(() => getIntrinsicApy(pair.collateral.asset.address))
const supplyApyWithRewards = computed(() => intrinsicSupplyApy.value + collateralRewardAPY.value)
const supplyRewardInfo = computed(() => getSupplyRewardCampaigns(pair.collateral.address))

const loopingRewardAPY = computed(() => getLoopingRewardApy(pair.borrow.address, pair.collateral.address))
const maxMultiplier = computed(() => getMaxMultiplier(pair.ltv.borrowLTV))
const maxRoe = computed(() =>
  getMaxRoe(maxMultiplier.value, supplyApyWithRewards.value, borrowApyWithRewards.value, loopingRewardAPY.value),
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

const onSupplyInfoIconClick = () => {
  modal.open(VaultSupplyApyModal, {
    props: {
      lendingAPY: 0, // Securitize vaults don't have interest rates
      intrinsicAPY: intrinsicSupplyApy.value,
      intrinsicApyInfo: getIntrinsicApyInfo(pair.collateral.asset.address),
      campaigns: supplyRewardInfo.value,
    },
  })
}

const onBorrowInfoIconClick = () => {
  modal.open(VaultBorrowApyModal, {
    props: {
      borrowingAPY: baseBorrowApy.value,
      intrinsicAPY: intrinsicBorrowApy.value,
      intrinsicApyInfo: getIntrinsicApyInfo(pair.borrow.asset.address),
      campaigns: borrowRewardInfo.value,
    },
  })
}

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
            <SvgIcon
              class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
              name="info-circle"
              data-modal-trigger="supply-apy"
              @click="onSupplyInfoIconClick"
            />
          </span>
        </template>
        <span class="flex items-center gap-4">
          <SvgIcon
            v-if="hasSupplyRewards(pair.collateral.address)"
            class="!w-20 !h-20 text-accent-500 cursor-pointer"
            name="sparks"
            data-modal-trigger="supply-apy"
            @click="onSupplyInfoIconClick"
          />
          {{ formatNumber(supplyApyWithRewards) }}%
        </span>
      </VaultOverviewLabelValue>
      <VaultOverviewLabelValue>
        <template #label>
          <span class="flex items-center gap-4">
            Borrow APY
            <SvgIcon
              class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
              name="info-circle"
              data-modal-trigger="borrow-apy"
              @click="onBorrowInfoIconClick"
            />
          </span>
        </template>
        <span class="flex items-center gap-4">
          <SvgIcon
            v-if="hasBorrowRewards(pair.borrow.address, pair.collateral.address)"
            class="!w-20 !h-20 text-accent-500 cursor-pointer"
            name="sparks"
            data-modal-trigger="borrow-apy"
            @click="onBorrowInfoIconClick"
          />
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
          <SvgIcon
            v-if="isRamping"
            name="arrow-top-right"
            class="!w-14 !h-14 text-warning-500 shrink-0 rotate-180 cursor-pointer"
            title="Liquidation LTV ramping down"
            @click.stop.prevent="onRampDownInfoIconClick($event, pair.ltv)"
          />
          {{ `${formatNumber(ltvToPercent(currentLiquidationLTV), 2)}%` }}
        </span>
      </VaultOverviewLabelValue>
    </div>
  </div>
</template>
