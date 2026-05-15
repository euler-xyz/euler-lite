<script setup lang="ts">
import { DateTime } from 'luxon'
import { formatNumber } from '~/utils/string-utils'
import type { RewardCampaign } from '~/entities/reward-campaign'
import { PROVIDER_LABELS, PROVIDER_LOGOS } from '~/entities/reward-campaign'
import type { IntrinsicApyInfo } from '~/entities/intrinsic-apy'

const emits = defineEmits(['close'])
const { borrowingAPY, intrinsicAPY, intrinsicApyInfo, campaigns, inline = false, close = true } = defineProps<{
  borrowingAPY: number
  intrinsicAPY?: number
  intrinsicApyInfo?: IntrinsicApyInfo
  campaigns?: RewardCampaign[]
  inline?: boolean
  close?: boolean
}>()

const rewardsTotalAPY = computed(() => {
  if (!campaigns || campaigns.length === 0) return null
  const total = campaigns.reduce((sum, c) => sum + c.apr, 0)
  return total > 0 ? total : null
})

const intrinsicApyValue = computed(() => intrinsicAPY ?? 0)
const hasIntrinsicApy = computed(() => intrinsicApyValue.value > 0)
const totalBorrowApy = computed(() => borrowingAPY + intrinsicApyValue.value - (rewardsTotalAPY.value || 0))

const rewardsInfo = computed(() => {
  if (!campaigns) return []
  return campaigns
    .filter(c => c.endTimestamp > Math.floor(Date.now() / 1000) || c.endTimestamp === 0)
    .map(c => ({
      id: `${c.vault}-${c.provider}-${c.type}-${c.endTimestamp}`,
      apr: c.apr,
      endDate: c.endTimestamp > 0 ? DateTime.fromSeconds(c.endTimestamp) : null,
      rewardToken: c.rewardToken || { symbol: 'Unknown', icon: '' },
      source: c.provider,
      sourceUrl: c.sourceUrl,
      isCollateralSpecific: c.type === 'euler_borrow_collateral',
    }))
    .sort((a, b) => a.rewardToken.symbol.localeCompare(b.rewardToken.symbol))
})

const handleClose = () => {
  emits('close')
}
</script>

<template>
  <BaseModalWrapper
    title="Borrow APY"
    :inline="inline"
    :close="close"
    @close="handleClose"
  >
    <div class="mb-24">
      <div
        class="pb-16 mb-16 border-b border-line-default"
      >
        <div class="flex justify-between items-center">
          <div>
            <p class="mb-4">
              Borrowing APY
            </p>
            <p class="text-content-primary">
              Cost of borrowing on Euler
            </p>
          </div>
          <div class="text-h5">
            {{ formatNumber(borrowingAPY) }}%
          </div>
        </div>
        <div
          v-if="hasIntrinsicApy"
          class="flex justify-between items-start gap-24 mt-16"
        >
          <div>
            <p class="mb-4">
              Intrinsic APY{{ intrinsicApyInfo?.provider ? ` (${intrinsicApyInfo.provider})` : '' }}
            </p>
            <p class="text-content-primary">
              Yield intrinsic to the borrowed asset, such as staking yield, which reduces effective borrowing cost
            </p>
            <a
              v-if="intrinsicApyInfo?.source"
              :href="intrinsicApyInfo.source"
              target="_blank"
              rel="noopener noreferrer"
              class="text-sm text-content-primary underline mt-4 inline-block"
            >
              Source
            </a>
          </div>
          <div class="text-h5 shrink-0">
            {{ formatNumber(intrinsicApyValue) }}%
          </div>
        </div>
      </div>
      <div
        v-if="rewardsTotalAPY !== null"
        class="flex justify-between items-center mb-16"
      >
        <div>
          <p class="mb-4 flex gap-4">
            <SvgIcon
              class="!w-20 !h-20 text-accent-500"
              name="sparks"
            />
            <span>Rewards APY</span>
          </p>
          <p class="text-content-primary">
            Yield from token rewards
          </p>
        </div>
        <div class="text-h5">
          - {{ formatNumber(rewardsTotalAPY) }}%
        </div>
      </div>
      <div
        v-for="reward in rewardsInfo"
        :key="reward.id"
        class="flex justify-between items-center mb-16"
      >
        <div class="flex">
          <img
            v-if="reward.rewardToken.icon"
            class="w-20 h-20"
            :src="reward.rewardToken.icon"
            alt="Reward token logo"
          >
          <p class="ml-12">
            {{ reward.rewardToken.symbol }}
          </p>
          <p class="ml-4 text-content-primary">
            (<a
              v-if="reward.sourceUrl"
              :href="reward.sourceUrl"
              target="_blank"
              rel="noopener noreferrer"
              class="underline"
              @click.stop
            ><img
              v-if="PROVIDER_LOGOS[reward.source]"
              :src="PROVIDER_LOGOS[reward.source]"
              class="w-14 h-14 inline-block align-middle mr-2 bg-white rounded-sm p-1"
              :alt="PROVIDER_LABELS[reward.source]"
            >{{ PROVIDER_LABELS[reward.source] || reward.source }}</a><template v-else>
              <img
                v-if="PROVIDER_LOGOS[reward.source]"
                :src="PROVIDER_LOGOS[reward.source]"
                class="w-14 h-14 inline-block align-middle mr-2 bg-white rounded-sm p-1"
                :alt="PROVIDER_LABELS[reward.source]"
              >{{ PROVIDER_LABELS[reward.source] || reward.source }}
            </template>{{ reward.isCollateralSpecific ? ', collateral bonus' : '' }}{{ reward.endDate ? `, ends ${reward.endDate.toFormat('MMMM dd, yyyy')}` : '' }})
          </p>
        </div>
        <div class="text-p2">
          {{ formatNumber(reward.apr) }}%
        </div>
      </div>
    </div>
    <div class="bg-surface-secondary rounded-12 p-16 flex justify-between items-center">
      <p>Total borrow APY</p>
      <p class="text-h4">
        {{ formatNumber(totalBorrowApy) }}%
      </p>
    </div>
  </BaseModalWrapper>
</template>
