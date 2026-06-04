<script setup lang="ts">
import { VaultRampDownModal, UiModalPreviewTrigger } from '#components'

const {
  pairBorrowLTVPercent,
  currentLiquidationLTVPercent,
  isRamping,
  isRestricted,
  isDeprecated,
  priceInvert,
  displayPrice,
  availableLiquidityDisplay,
  rampDownModalData,
  formatSignificant,
  formatNumber,
} = useVaultOverviewPairOverviewContext()
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
              <UiFootnote
                title="Max LTV"
                text="The maximum loan-to-value allowed for this collateral and borrow pair before new borrowing is restricted."
                tooltip-placement="top-start"
              />
            </span>
          </template>
          {{ pairBorrowLTVPercent === null ? '-' : `${formatNumber(pairBorrowLTVPercent, 2)}%` }}
        </VaultOverviewLabelValue>

        <VaultOverviewLabelValue>
          <template #label>
            <span class="flex items-center gap-4">
              Liquidation LTV
              <UiFootnote
                title="Liquidation LTV"
                text="The loan-to-value where the position becomes eligible for liquidation. If this value is ramping, the current value can change over time."
                tooltip-placement="top-start"
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
    </div>
  </div>
</template>
