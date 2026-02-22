<script setup lang="ts">
import type { EarnVault } from '~/entities/vault'
import { formatAssetValue } from '~/services/pricing/priceProvider'
import { formatNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultSupplyApyModal } from '#components'

const { vault } = defineProps<{ vault: EarnVault }>()

const modal = useModal()
const { getVault } = useVaults()
const { getIntrinsicApy, getIntrinsicApyInfo } = useIntrinsicApy()
const { getSupplyRewardApy, getSupplyRewardCampaigns, hasSupplyRewards } = useRewardsApy()

const availableLiquidityOfStrategies = ref(0n)

const rewardSupplyAPY = computed(() => getSupplyRewardApy(vault.address))

const totalSupplyDisplay = ref('-')

watchEffect(async () => {
  const price = await formatAssetValue(vault.totalAssets, vault, 'off-chain')
  totalSupplyDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
})

const availableLiquidityDisplay = ref('-')

watchEffect(async () => {
  const price = await formatAssetValue(availableLiquidityOfStrategies.value, vault, 'off-chain')
  availableLiquidityDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
})

const load = async () => {
  vault.strategies.forEach(async (strategy) => {
    const vlt = await getVault(strategy.info.vault)
    const liquidity = vlt.supply - vlt.borrow
    availableLiquidityOfStrategies.value += strategy.allocatedAssets - (liquidity < strategy.allocatedAssets ? strategy.allocatedAssets - liquidity : 0n)
  })
}

load()

const onSupplyInfoIconClick = () => {
  modal.open(VaultSupplyApyModal, {
    props: {
      lendingAPY: nanoToValue(vault.interestRateInfo.supplyAPY, 25),
      intrinsicAPY: getIntrinsicApy(vault.asset.address),
      intrinsicApyInfo: getIntrinsicApyInfo(vault.asset.address),
      campaigns: getSupplyRewardCampaigns(vault.address),
    },
  })
}
</script>

<template>
  <div class="flex flex-col gap-24 p-24 border-b border-line-default last:border-b-0">
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
          Supply APY
        </template>
        <span class="flex items-center gap-4">
          <SvgIcon
            v-if="hasSupplyRewards(vault.address)"
            class="!w-20 !h-20 text-accent-500 cursor-pointer"
            name="sparks"
            @click="onSupplyInfoIconClick"
          />
          {{ formatNumber(nanoToValue(vault.interestRateInfo.supplyAPY, 25) + rewardSupplyAPY) }}%
        </span>
      </VaultOverviewLabelValue>
    </div>
  </div>
</template>
