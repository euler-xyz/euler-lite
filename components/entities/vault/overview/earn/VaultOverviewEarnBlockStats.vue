<script setup lang="ts">
import { computeSupplyApyBreakdown, type EulerEarn } from '@eulerxyz/euler-v2-sdk'
import { formatAssetValue } from '~/utils/sdk-prices'
import { formatNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { VaultApyModal, UiModalPreviewTrigger } from '#components'
import { getVaultIntrinsicApyInfo } from '~/utils/vault-intrinsic-apy'
import { computeUncoveredLosses } from '~/utils/vault/earn-losses'

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

// `lostAssets` is never written back down once a shortfall is covered, so net it
// off against the shares parked at address(1) before showing it as still unbacked.
const { coverageShares } = useEarnLossCoverage(computed(() => vault))
const uncoveredLosses = computed(() => computeUncoveredLosses(vault, coverageShares.value))

const uncoveredLossesDisplay = ref('-')

watchEffect(async () => {
  const price = await formatAssetValue(uncoveredLosses.value, vault, 'off-chain')
  uncoveredLossesDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
})

const supplyApyModalData = computed(() => ({
  props: {
    mode: 'supply',
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
      :value="uncoveredLossesDisplay"
      orientation="horizontal"
      data-field="Uncovered losses"
    >
      <template #label>
        <span class="flex items-center gap-4">
          Uncovered losses
          <UiHoverPreviewTooltip
            title="Uncovered Losses"
            text="Assets the vault is missing after realised bad debt in a strategy or a forced strategy removal, less any part of the shortfall someone has already covered. The full loss stays counted in total supply so the share price does not drop instantly, so whatever is shown here is the portion of total supply that is currently unbacked."
            icon-class="text-content-muted hover:text-content-secondary"
          />
        </span>
      </template>
    </VaultOverviewLabelValue>
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
          :component="VaultApyModal"
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
