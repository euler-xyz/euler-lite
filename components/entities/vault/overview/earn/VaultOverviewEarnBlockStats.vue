<script setup lang="ts">
import { computeSupplyApyBreakdown, type EulerEarn } from '@eulerxyz/euler-v2-sdk'
import { formatAssetValue } from '~/utils/sdk-prices'
import { formatNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { VaultSupplyApyModal, UiModalPreviewTrigger } from '#components'
import { getVaultIntrinsicApyInfo } from '~/utils/vault-intrinsic-apy'

const { vault, defaultOpen = true } = defineProps<{ vault: EulerEarn, defaultOpen?: boolean }>()

const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { getSupplyRewardCampaigns, hasSupplyRewards } = useRewardsApy()
const { viewer, visibleTotal, visibleBreakdown } = useApyVisibility()

const supplyApyBreakdown = computed(() => computeSupplyApyBreakdown(vault, viewer.value))
const visibleApyBreakdown = computed(() => visibleBreakdown(supplyApyBreakdown.value))
const supplyApyTotal = computed(() => visibleTotal(supplyApyBreakdown.value) ?? 0)
const hasRewards = computed(() => settings.value.enableRewardsApy && hasSupplyRewards(vault.address))

const totalSupplyDisplay = ref('-')

watchEffect(async () => {
  const price = await formatAssetValue(vault.totalAssets, vault, 'off-chain')
  totalSupplyDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
})

const availableLiquidityDisplay = ref('-')

watchEffect(async () => {
  const price = await formatAssetValue(vault.availableAssets, vault, 'off-chain')
  availableLiquidityDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
})

const supplyApyModalData = computed(() => ({
  props: {
    lendingAPY: visibleApyBreakdown.value?.lending ?? 0,
    intrinsicAPY: visibleApyBreakdown.value?.intrinsicApy ?? 0,
    intrinsicApyInfo: getVaultIntrinsicApyInfo(vault, enableIntrinsicApy.value),
    campaigns: settings.value.enableRewardsApy ? getSupplyRewardCampaigns(vault.address) : [],
    totalSupplyAPY: supplyApyTotal.value,
    rewardVaultAddress: vault.address,
  },
}))
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
      label="Available liquidity"
      :value="availableLiquidityDisplay"
      orientation="horizontal"
    />
    <VaultOverviewLabelValue
      label="Total strategies"
      :value="String(vault.strategies.length)"
      orientation="horizontal"
      data-field="Total strategies"
      :data-value="vault.strategies.length"
    />
    <VaultOverviewLabelValue
      orientation="horizontal"
    >
      <template #label>
        Supply APY
      </template>
      <span class="flex items-center gap-4">
        <UiModalPreviewTrigger
          v-if="hasRewards"
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
        {{ formatNumber(supplyApyTotal) }}%
      </span>
    </VaultOverviewLabelValue>
  </VaultOverviewAccordionSection>
</template>
