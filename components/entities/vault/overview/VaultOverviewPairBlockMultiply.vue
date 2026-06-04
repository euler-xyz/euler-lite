<script setup lang="ts">
import { VaultMaxRoeModal, UiModalPreviewTrigger } from '#components'

const {
  collateralVault,
  borrowVault,
  pairBorrowLTVPercent,
  maxMultiplier,
  maxRoe,
  maxRoeModalData,
  hasSupplyRewards,
  hasBorrowRewards,
  hasLoopingRewards,
  formatNumber,
} = useVaultOverviewPairOverviewContext()
</script>

<template>
  <div class="bg-surface-secondary rounded-xl flex flex-col gap-24 p-24 shadow-card">
    <p class="text-h3 text-content-primary">
      Multiply
    </p>
    <div class="flex flex-col items-start gap-24">
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
        <span class="flex items-center gap-4 text-accent-600 font-semibold">
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
  </div>
</template>
