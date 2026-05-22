<script setup lang="ts">
import type { AnyBorrowVaultPair } from '~/entities/vault'
import { isAnyVaultBlockedByCountry } from '~/composables/useGeoBlock'
import { isVaultDeprecated } from '~/utils/eulerLabelsUtils'
import { getCollateralOraclePrice, getAssetOraclePrice, formatAssetValue } from '~/services/pricing/priceProvider'
import { formatNumber, formatSignificant, formatCompactUsdValue, compactNumber } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { getMaxMultiplier, getMaxRoe } from '~/utils/leverage'
import type { AccountBorrowPosition } from '~/entities/account'
import { VaultNetApyPairModal, VaultMaxRoeModal, VaultSupplyApyModal, VaultBorrowApyModal } from '#components'

const { pair } = defineProps<{ pair: AnyBorrowVaultPair | AccountBorrowPosition }>()

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

const availableLiquidityDisplay = ref({ amount: '-', symbol: '', usd: '' })
const formatLiquidityAmount = (amount: number) => {
  if (!Number.isFinite(amount)) return '-'
  if (Math.abs(amount) >= 10_000) return compactNumber(amount, 2, 0)
  return formatNumber(amount, 1, 0)
}

watchEffect(async () => {
  const liquidity = pair.borrow.supply >= pair.borrow.borrow ? pair.borrow.supply - pair.borrow.borrow : 0n
  const price = await formatAssetValue(liquidity, pair.borrow, 'off-chain')
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
      <div class="grid grid-cols-1 laptop:grid-cols-6 gap-x-32 gap-y-16">
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

        <div class="h-px bg-line-subtle my-4 laptop:col-span-6" />

        <div class="flex items-center gap-8 text-h6 uppercase text-content-secondary laptop:col-span-6">
          <SvgIcon
            name="arrow-big"
            class="!w-16 !h-16"
          />
          Borrow
        </div>

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
              />
            </UiModalPreviewTrigger>
          </div>
          <div class="flex items-center gap-4 text-p2 font-semibold text-content-primary">
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
              />
            </UiModalPreviewTrigger>
          </div>
          <div class="flex items-center gap-4 text-p2 font-semibold text-content-primary">
            <VaultPoints :vault="pair.collateral" />
            <UiModalPreviewTrigger
              v-if="hasSupplyRewards(pair.collateral.address)"
              :component="VaultSupplyApyModal"
              :modal-data="supplyApyModalData"
              aria-label="Show collateral APY rewards breakdown"
            >
              <SvgIcon
                class="!w-20 !h-20 text-accent-500 cursor-pointer"
                name="sparks"
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
              />
            </UiModalPreviewTrigger>
          </div>
          <div class="flex items-center gap-4 text-p2 font-semibold text-content-primary">
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
          </div>
        </div>

        <div
          v-if="isBorrowable"
          class="h-px bg-line-subtle my-4 laptop:col-span-6"
        />

        <div
          v-if="isBorrowable"
          class="flex items-center gap-8 text-h6 uppercase text-accent-500 laptop:col-span-6"
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
              {{ formatNumber(maxMultiplier, 2, 2) }}x
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
                />
              </UiModalPreviewTrigger>
            </div>
            <div class="flex items-center gap-4 text-p2 font-semibold text-content-primary">
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
            </div>
          </div>
        </template>
      </div>
    </div>
  </div>
</template>
