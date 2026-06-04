<script setup lang="ts">
import { VaultNetApyPairModal, VaultSupplyApyModal, VaultBorrowApyModal, UiModalPreviewTrigger } from '#components'

const {
  collateralVault,
  borrowVault,
  supplyApyWithRewards,
  borrowApyWithRewards,
  netApy,
  supplyApyModalData,
  borrowApyModalData,
  netApyModalData,
  hasSupplyRewards,
  hasBorrowRewards,
  hasLoopingRewards,
  formatNumber,
} = useVaultOverviewPairOverviewContext()
</script>

<template>
  <div class="bg-surface-secondary rounded-xl flex flex-col gap-24 p-24 shadow-card">
    <p class="text-h3 text-content-primary">
      Borrow
    </p>
    <div class="flex flex-col items-start gap-24">
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
        <span class="flex items-center gap-4 text-accent-600 font-semibold">
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
  </div>
</template>
