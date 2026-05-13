<script setup lang="ts">
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { getUtilisationWarning } from '~/composables/useVaultWarnings'
import { formatAssetValue } from '~/utils/sdk-prices'
import { formatNumber, compactNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { VaultSupplyApyModal, VaultBorrowApyModal } from '#components'

const { vault } = defineProps<{ vault: EVault }>()

const { withIntrinsicBorrowApy, withIntrinsicSupplyApy, getIntrinsicApy, getIntrinsicApyInfo } = useIntrinsicApy()
const { getSupplyRewardApy, getBorrowRewardApy, getSupplyRewardCampaigns, getBorrowRewardCampaigns, hasSupplyRewards, hasBorrowRewards } = useRewardsApy()
const isBorrowable = computed(() => vault.collaterals.some(ltv => ltv.borrowLTV > 0))

const supplyApyWithRewards = computed(() => withIntrinsicSupplyApy(
  getVaultSupplyApy(vault),
  vault.asset.address,
) + getSupplyRewardApy(vault.address))
// Vault overview shows generic borrow rewards (no specific collateral context available here)
const borrowApyWithRewards = computed(() => withIntrinsicBorrowApy(
  getVaultBorrowApy(vault),
  vault.asset.address,
) - getBorrowRewardApy(vault.address))

const supplyRewardInfo = computed(() => getSupplyRewardCampaigns(vault.address))
const borrowRewardInfo = computed(() => getBorrowRewardCampaigns(vault.address))

const supplyApyModalData = computed(() => ({
  props: {
    lendingAPY: nanoToValue(vault.interestRateInfo.supplyAPY, 25),
    intrinsicAPY: getIntrinsicApy(vault.asset.address),
    intrinsicApyInfo: getIntrinsicApyInfo(vault.asset.address),
    campaigns: supplyRewardInfo.value,
  },
}))

const borrowApyModalData = computed(() => ({
  props: {
    borrowingAPY: nanoToValue(vault.interestRateInfo.borrowAPY, 25),
    intrinsicAPY: getIntrinsicApy(vault.asset.address),
    intrinsicApyInfo: getIntrinsicApyInfo(vault.asset.address),
    campaigns: borrowRewardInfo.value,
  },
}))

const utilization = computed(() => vault.utilization)
const utilisationWarning = computed(() => getUtilisationWarning(vault, 'general'))

const totalSupplyDisplay = ref('-')
const totalBorrowedDisplay = ref('-')
const availableLiquidityDisplay = ref('-')

watchEffect(async () => {
  const price = await formatAssetValue(vault.totalAssets, vault, 'off-chain')
  totalSupplyDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
})

watchEffect(async () => {
  const price = await formatAssetValue(vault.totalBorrowed, vault, 'off-chain')
  totalBorrowedDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
})

watchEffect(async () => {
  const liquidity = vault.availableLiquidity
  const price = await formatAssetValue(liquidity, vault, 'off-chain')
  availableLiquidityDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
})
</script>

<template>
  <div class="bg-surface-secondary rounded-xl flex flex-col gap-24 p-24 shadow-card">
    <p class="text-h3 text-content-primary">
      Statistics
    </p>
    <div class="flex flex-col items-start gap-24">
      <VaultOverviewLabelValue
        label="Total supply"
        :value="totalSupplyDisplay"
        orientation="horizontal"
      />
      <VaultOverviewLabelValue
        v-if="isBorrowable"
        label="Total borrowed"
        :value="totalBorrowedDisplay"
        orientation="horizontal"
      />
      <VaultOverviewLabelValue
        v-if="isBorrowable"
        label="Available liquidity"
        :value="availableLiquidityDisplay"
        orientation="horizontal"
      />
      <VaultOverviewLabelValue
        orientation="horizontal"
      >
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
          <UiModalPreviewTrigger
            v-if="hasSupplyRewards(vault.address)"
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
      <VaultOverviewLabelValue
        v-if="isBorrowable"
        orientation="horizontal"
      >
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
            v-if="hasBorrowRewards(vault.address)"
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
      <VaultOverviewLabelValue
        v-if="isBorrowable"
        orientation="horizontal"
      >
        <template #label>
          <span class="flex items-center gap-4">
            Utilization
            <VaultWarningIcon :warning="utilisationWarning" />
          </span>
        </template>
        <div class="flex gap-4 items-center">
          {{ compactNumber(utilization, 2, 2) }}%
          <UiRadialProgress
            :value="utilization"
            :max="100"
          />
        </div>
      </VaultOverviewLabelValue>
    </div>
  </div>
</template>
