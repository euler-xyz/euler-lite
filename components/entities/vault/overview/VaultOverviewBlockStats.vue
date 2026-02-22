<script setup lang="ts">
import { getVaultUtilization, type Vault } from '~/entities/vault'
import { getUtilisationWarning } from '~/composables/useVaultWarnings'
import { formatAssetValue } from '~/services/pricing/priceProvider'
import { formatNumber, compactNumber, formatCompactUsdValue } from '~/utils/string-utils'
import { nanoToValue } from '~/utils/crypto-utils'
import { useModal } from '~/components/ui/composables/useModal'
import { VaultSupplyApyModal, VaultBorrowApyModal } from '#components'

const { vault } = defineProps<{ vault: Vault }>()

const modal = useModal()
const { withIntrinsicBorrowApy, withIntrinsicSupplyApy, getIntrinsicApy, getIntrinsicApyInfo } = useIntrinsicApy()
const { getSupplyRewardApy, getBorrowRewardApy, getSupplyRewardCampaigns, getBorrowRewardCampaigns, hasSupplyRewards, hasBorrowRewards } = useRewardsApy()
const isBorrowable = computed(() => vault.collateralLTVs.some(ltv => ltv.borrowLTV > 0n))

const supplyApyWithRewards = computed(() => withIntrinsicSupplyApy(
  nanoToValue(vault.interestRateInfo.supplyAPY, 25),
  vault.asset.address,
) + getSupplyRewardApy(vault.address))
// Vault overview shows generic borrow rewards (no specific collateral context available here)
const borrowApyWithRewards = computed(() => withIntrinsicBorrowApy(
  nanoToValue(vault.interestRateInfo.borrowAPY, 25),
  vault.asset.address,
) - getBorrowRewardApy(vault.address))

const supplyRewardInfo = computed(() => getSupplyRewardCampaigns(vault.address))
const borrowRewardInfo = computed(() => getBorrowRewardCampaigns(vault.address))

const onSupplyInfoIconClick = () => {
  modal.open(VaultSupplyApyModal, {
    props: {
      lendingAPY: nanoToValue(vault.interestRateInfo.supplyAPY, 25),
      intrinsicAPY: getIntrinsicApy(vault.asset.address),
      intrinsicApyInfo: getIntrinsicApyInfo(vault.asset.address),
      campaigns: supplyRewardInfo.value,
    },
  })
}

const onBorrowInfoIconClick = () => {
  modal.open(VaultBorrowApyModal, {
    props: {
      borrowingAPY: nanoToValue(vault.interestRateInfo.borrowAPY, 25),
      intrinsicAPY: getIntrinsicApy(vault.asset.address),
      intrinsicApyInfo: getIntrinsicApyInfo(vault.asset.address),
      campaigns: borrowRewardInfo.value,
    },
  })
}

const utilization = computed(() => getVaultUtilization(vault))
const utilisationWarning = computed(() => getUtilisationWarning(vault, 'general'))

const totalSupplyDisplay = ref('-')
const totalBorrowedDisplay = ref('-')
const availableLiquidityDisplay = ref('-')

watchEffect(async () => {
  const price = await formatAssetValue(vault.supply, vault, 'off-chain')
  totalSupplyDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
})

watchEffect(async () => {
  const price = await formatAssetValue(vault.borrow, vault, 'off-chain')
  totalBorrowedDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
})

watchEffect(async () => {
  const liquidity = vault.supply >= vault.borrow ? vault.supply - vault.borrow : 0n
  const price = await formatAssetValue(liquidity, vault, 'off-chain')
  availableLiquidityDisplay.value = price.hasPrice ? formatCompactUsdValue(price.usdValue) : price.display
})
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
            <SvgIcon
              class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
              name="info-circle"
              @click="onSupplyInfoIconClick"
            />
          </span>
        </template>
        <span class="flex items-center gap-4">
          <SvgIcon
            v-if="hasSupplyRewards(vault.address)"
            class="!w-20 !h-20 text-accent-500 cursor-pointer"
            name="sparks"
            @click="onSupplyInfoIconClick"
          />
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
            <SvgIcon
              class="!w-20 !h-20 text-content-muted cursor-pointer hover:text-content-secondary"
              name="info-circle"
              @click="onBorrowInfoIconClick"
            />
          </span>
        </template>
        <span class="flex items-center gap-4">
          <SvgIcon
            v-if="hasBorrowRewards(vault.address)"
            class="!w-20 !h-20 text-accent-500 cursor-pointer"
            name="sparks"
            @click="onBorrowInfoIconClick"
          />
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
