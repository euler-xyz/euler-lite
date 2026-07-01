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

const { pair, defaultOpen = true } = defineProps<{ pair: AnyBorrowVaultPair | PortfolioBorrowPosition<VaultEntity>, defaultOpen?: boolean }>()

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

// Gate multiply metrics on this pair's borrow LTV, not vault-level borrowability.
const showMultiplySection = computed(() => (pairBorrowLTV.value ?? 0) > 0)
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
const netApyClass = computed(() => netApy.value >= 0 ? 'text-accent-600' : 'text-error-500')
const maxRoeClass = computed(() => maxRoe.value >= 0 ? 'text-accent-600' : 'text-error-500')

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
  <VaultOverviewAccordionSection
    title="Overview"
    :default-open="defaultOpen"
    content-class="flex flex-col gap-20"
  >
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
    <div class="flex flex-col gap-12">
      <div class="grid grid-cols-2 gap-x-32 gap-y-20">
        <VaultOverviewLabelValue label="Price">
          <template v-if="displayPrice !== undefined">
            <div class="flex flex-col gap-2">
              <span class="tabular-nums">
                {{ formatSignificant(displayPrice, 4) }}
              </span>
              <span
                v-if="priceInvert.displaySymbol"
                class="text-p3 text-content-muted flex items-center gap-4"
              >
                {{ priceInvert.displaySymbol }}
                <button
                  type="button"
                  aria-label="Invert price display"
                  class="text-content-tertiary hover:text-content-primary transition-colors inline-flex shrink-0"
                  @click.stop="priceInvert.toggle"
                >
                  <SvgIcon
                    name="swap-horizontal"
                    class="!w-12 !h-12"
                  />
                </button>
              </span>
            </div>
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

        <VaultOverviewLabelValue label="Available liquidity">
          <div class="flex flex-col gap-2">
            <span class="flex items-baseline gap-4 tabular-nums">
              {{ availableLiquidityDisplay.amount }}
              <span
                v-if="availableLiquidityDisplay.symbol"
                class="text-content-tertiary"
              >
                {{ availableLiquidityDisplay.symbol }}
              </span>
            </span>
            <span
              v-if="availableLiquidityDisplay.usd"
              class="text-p3 text-content-muted"
            >
              {{ availableLiquidityDisplay.usd }}
            </span>
          </div>
        </VaultOverviewLabelValue>

        <VaultOverviewLabelValue>
          <template #label>
            <span class="flex items-center gap-4">
              Max LTV
              <UiHoverPreviewTooltip
                title="Max LTV"
                text="The maximum loan-to-value allowed for this collateral and borrow pair before new borrowing is restricted."
                placement="top-start"
              />
            </span>
          </template>
          {{ pairBorrowLTVPercent === null ? '-' : `${formatNumber(pairBorrowLTVPercent, 2)}%` }}
        </VaultOverviewLabelValue>

        <VaultOverviewLabelValue>
          <template #label>
            <span class="flex items-center gap-4">
              Liquidation LTV
              <UiHoverPreviewTooltip
                title="Liquidation LTV"
                text="The loan-to-value where the position becomes eligible for liquidation. If this value is ramping, the current value can change over time."
                placement="top-start"
              />
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
            {{ currentLiquidationLTVPercent === null ? '-' : `${formatNumber(currentLiquidationLTVPercent, 2)}%` }}
          </span>
        </VaultOverviewLabelValue>
      </div>

      <div class="flex items-center gap-12 pt-8">
        <p class="text-p4 uppercase tracking-[0.14em] text-content-muted whitespace-nowrap">
          Rates & multiply
        </p>
        <div class="h-2 flex-1 bg-[var(--border-subtle)] opacity-70" />
      </div>

      <div
        class="grid grid-cols-1 gap-12 min-w-0"
        :class="{ 'laptop:grid-cols-2': showMultiplySection }"
      >
        <VaultOverviewPairSection
          title="Borrow"
          icon="arrow-big"
        >
          <div class="flex flex-col gap-12">
            <VaultOverviewLabelValue orientation="horizontal">
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
                <VaultPoints :vault="collateralVault" />
                <UiModalPreviewTrigger
                  v-if="hasSupplyRewards(collateralVault.address)"
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

            <VaultOverviewLabelValue orientation="horizontal">
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
              </span>
            </VaultOverviewLabelValue>

            <VaultOverviewLabelValue orientation="horizontal">
              <template #label>
                <span class="flex items-center gap-4">
                  Net APY
                  <UiModalPreviewTrigger
                    :component="VaultNetApyPairModal"
                    :modal-data="netApyModalData"
                    aria-label="Show net APY breakdown"
                  >
                    <SvgIcon
                      class="!w-20 !h-20 text-content-muted hover:text-content-secondary cursor-pointer"
                      name="info-circle"
                      data-modal-trigger="net-apy"
                    />
                  </UiModalPreviewTrigger>
                </span>
              </template>
              <span
                class="flex items-center gap-4 font-semibold"
                :class="netApyClass"
              >
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
              </span>
            </VaultOverviewLabelValue>
          </div>
        </VaultOverviewPairSection>

        <VaultOverviewPairSection
          v-if="showMultiplySection"
          title="Multiply"
          icon="multiply"
        >
          <div class="flex flex-col gap-12">
            <VaultOverviewLabelValue
              orientation="horizontal"
              label="Max multiplier"
              :value="pairBorrowLTVPercent === null ? '-' : `${formatNumber(maxMultiplier, 2, 2)}x`"
            />

            <VaultOverviewLabelValue orientation="horizontal">
              <template #label>
                <span class="flex items-center gap-4">
                  Max ROE
                  <UiModalPreviewTrigger
                    :component="VaultMaxRoeModal"
                    :modal-data="maxRoeModalData"
                    aria-label="Show max ROE breakdown"
                  >
                    <SvgIcon
                      class="!w-20 !h-20 text-content-muted hover:text-content-secondary cursor-pointer"
                      name="info-circle"
                      data-modal-trigger="max-roe"
                    />
                  </UiModalPreviewTrigger>
                </span>
              </template>
              <span
                class="flex items-center gap-4 font-semibold"
                :class="maxRoeClass"
              >
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
              </span>
            </VaultOverviewLabelValue>
          </div>
        </VaultOverviewPairSection>
      </div>
    </div>
  </VaultOverviewAccordionSection>
</template>
