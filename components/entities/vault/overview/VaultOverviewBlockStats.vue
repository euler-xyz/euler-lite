<script setup lang="ts">
import type { EVault } from '@eulerxyz/euler-v2-sdk'
import { getUtilisationWarning } from '~/composables/useVaultWarnings'
import { formatAssetValue } from '~/utils/sdk-prices'
import { formatNumber, compactNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { VaultSupplyApyModal, VaultBorrowApyModal, UiModalPreviewTrigger } from '#components'
import { withVaultIntrinsicApy, getVaultIntrinsicApy, getVaultIntrinsicApyInfo } from '~/utils/vault-intrinsic-apy'
import { isVaultBorrowable } from '~/utils/vault/classification'

const { vault, defaultOpen = true } = defineProps<{ vault: EVault, defaultOpen?: boolean }>()

const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { getSupplyRewardApy, getBorrowRewardApy, getSupplyRewardCampaigns, getBorrowRewardCampaigns, hasSupplyRewards, hasBorrowRewards } = useRewardsApy()
const isBorrowable = computed(() => isVaultBorrowable(vault))

const supplyApyWithRewards = computed(() => withVaultIntrinsicApy(
  getVaultSupplyApy(vault),
  vault,
  enableIntrinsicApy.value,
) + getSupplyRewardApy(vault.address))
// Vault overview shows generic borrow rewards (no specific collateral context available here)
const borrowApyWithRewards = computed(() => withVaultIntrinsicApy(
  getVaultBorrowApy(vault),
  vault,
  enableIntrinsicApy.value,
) - getBorrowRewardApy(vault.address))

const supplyRewardInfo = computed(() => getSupplyRewardCampaigns(vault.address))
const borrowRewardInfo = computed(() => getBorrowRewardCampaigns(vault.address))

const supplyApyModalData = computed(() => ({
  props: {
    lendingAPY: getVaultSupplyApy(vault),
    intrinsicAPY: getVaultIntrinsicApy(vault, enableIntrinsicApy.value),
    intrinsicApyInfo: getVaultIntrinsicApyInfo(vault, enableIntrinsicApy.value),
    campaigns: supplyRewardInfo.value,
    rewardVaultAddress: vault.address,
  },
}))

const borrowApyModalData = computed(() => ({
  props: {
    borrowingAPY: getVaultBorrowApy(vault),
    intrinsicAPY: getVaultIntrinsicApy(vault, enableIntrinsicApy.value),
    intrinsicApyInfo: getVaultIntrinsicApyInfo(vault, enableIntrinsicApy.value),
    campaigns: borrowRewardInfo.value,
    rewardVaultAddress: vault.address,
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
  <VaultOverviewAccordionSection
    title="Statistics"
    :default-open="defaultOpen"
    content-class="flex flex-col items-start gap-24"
  >
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
              class="!w-20 !h-20 text-content-muted hover:text-content-secondary cursor-pointer"
              name="info-circle"
              data-modal-trigger="supply-apy"
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
            data-modal-trigger="supply-apy"
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
              class="!w-20 !h-20 text-content-muted hover:text-content-secondary cursor-pointer"
              name="info-circle"
              data-modal-trigger="borrow-apy"
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
            data-modal-trigger="borrow-apy"
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
  </VaultOverviewAccordionSection>
</template>
