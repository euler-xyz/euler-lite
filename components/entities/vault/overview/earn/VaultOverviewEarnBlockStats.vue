<script setup lang="ts">
import type { EulerEarn } from '@eulerxyz/euler-v2-sdk'
import { formatAssetValue } from '~/utils/sdk-prices'
import { formatNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { VaultSupplyApyModal, UiModalPreviewTrigger } from '#components'
import { getVaultIntrinsicApy, getVaultIntrinsicApyInfo } from '~/utils/vault-intrinsic-apy'

const { vault } = defineProps<{ vault: EulerEarn }>()

const { settings } = useUserSettings()
const enableIntrinsicApy = computed(() => settings.value.enableIntrinsicApy)
const { getSupplyRewardApy, getSupplyRewardCampaigns, hasSupplyRewards } = useRewardsApy()

const rewardSupplyAPY = computed(() => getSupplyRewardApy(vault.address))
const intrinsicApy = computed(() => getVaultIntrinsicApy(vault, enableIntrinsicApy.value))
const supplyApyTotal = computed(() => getVaultSupplyApy(vault) + intrinsicApy.value + rewardSupplyAPY.value)

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
    intrinsicAPY: getVaultIntrinsicApy(vault, enableIntrinsicApy.value),
    intrinsicApyInfo: getVaultIntrinsicApyInfo(vault, enableIntrinsicApy.value),
    campaigns: getSupplyRewardCampaigns(vault.address),
    totalSupplyAPY: supplyApyTotal.value,
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
          {{ formatNumber(supplyApyTotal) }}%
        </span>
      </VaultOverviewLabelValue>
    </div>
  </div>
</template>
