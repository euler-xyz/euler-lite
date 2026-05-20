<script setup lang="ts">
import type { EulerEarn } from '@eulerxyz/euler-v2-sdk'
import { formatAssetValue } from '~/utils/sdk-prices'
import { formatNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { VaultSupplyApyModal, UiModalPreviewTrigger } from '#components'

const { vault } = defineProps<{ vault: EulerEarn }>()

const { getIntrinsicApy, getIntrinsicApyInfo } = useIntrinsicApy()
const { getSupplyRewardApy, getSupplyRewardCampaigns, hasSupplyRewards } = useRewardsApy()

const rewardSupplyAPY = computed(() => getSupplyRewardApy(vault.address))

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
    lendingAPY: getVaultSupplyApy(vault),
    intrinsicAPY: getIntrinsicApy(vault.asset.address),
    intrinsicApyInfo: getIntrinsicApyInfo(vault.asset.address),
    campaigns: getSupplyRewardCampaigns(vault.address),
    rewardVaultAddress: vault.address,
    baseApyAverageLabel: '1h',
  },
}))
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
        label="Available liquidity"
        :value="availableLiquidityDisplay"
        orientation="horizontal"
      />
      <UiModalPreviewTrigger
        :component="VaultSupplyApyModal"
        :modal-data="() => supplyApyModalData"
        aria-label="Supply APY details"
      >
        <VaultOverviewLabelValue
          orientation="horizontal"
        >
          <template #label>
            <span class="flex items-center gap-6">
              Supply APY
              <span class="inline-flex items-center rounded-8 px-8 py-2 bg-accent-100 text-accent-600 text-p5">
                1h
              </span>
            </span>
          </template>
          <span class="flex items-center gap-4">
            <SvgIcon
              v-if="hasSupplyRewards(vault.address)"
              class="!w-20 !h-20 text-accent-500"
              name="sparks"
              data-modal-trigger="supply-apy"
            />
            {{ formatNumber(getVaultSupplyApy(vault) + rewardSupplyAPY) }}%
          </span>
        </VaultOverviewLabelValue>
      </UiModalPreviewTrigger>
    </div>
  </div>
</template>
