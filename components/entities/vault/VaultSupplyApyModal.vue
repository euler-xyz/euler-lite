<script setup lang="ts">
import { DateTime } from 'luxon'
import { formatNumber } from '~/utils/string-utils'
import type { RewardCampaign } from '~/entities/reward-campaign'
import { PROVIDER_LABELS, PROVIDER_LOGOS } from '~/entities/reward-campaign'
import type { IntrinsicApyInfo } from '~/entities/intrinsic-apy'

const emits = defineEmits(['close'])
const { lendingAPY, intrinsicAPY, intrinsicApyInfo, campaigns, baseApyAverageLabel, inline = false, close = true } = defineProps<{
  lendingAPY: number
  intrinsicAPY?: number
  intrinsicApyInfo?: IntrinsicApyInfo
  campaigns?: RewardCampaign[]
  baseApyAverageLabel?: string
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
const totalSupplyApy = computed(() => lendingAPY + intrinsicApyValue.value + (rewardsTotalAPY.value || 0))

const rewardsInfo = computed(() => {
  if (!campaigns) return []
  return campaigns
    .filter(c => c.endTimestamp > Math.floor(Date.now() / 1000) || c.endTimestamp === 0)
    .map(c => ({
      id: `${c.vault}-${c.provider}-${c.endTimestamp}`,
      apr: c.apr,
      endDate: c.endTimestamp > 0 ? DateTime.fromSeconds(c.endTimestamp) : null,
      rewardToken: c.rewardToken || { symbol: 'Unknown', icon: '' },
      source: c.provider,
      sourceUrl: c.sourceUrl,
    }))
    .sort((a, b) => a.rewardToken.symbol.localeCompare(b.rewardToken.symbol))
})

const handleClose = () => {
  emits('close')
}
</script>

<template>
  <BaseModalWrapper
    title="Supply APY"
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
            <p class="mb-4 flex items-center gap-6">
              Lending APY
              <span
                v-if="baseApyAverageLabel"
                class="inline-flex items-center rounded-8 px-8 py-2 bg-accent-100 text-accent-600 text-p5"
              >
                {{ baseApyAverageLabel }}
              </span>
            </p>
            <p class="text-content-primary">
              Yield from lending on Euler
            </p>
          </div>
          <div class="text-h5">
            {{ formatNumber(lendingAPY) }}%
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
              Yield intrinsic to the supplied asset, such as staking yield or external rewards, might be compounded with lending yield
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
          + {{ formatNumber(rewardsTotalAPY) }}%
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
            class="w-20 h-20 rounded-full"
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
            </template>{{ reward.endDate ? `, ends ${reward.endDate.toFormat('MMMM dd, yyyy')}` : '' }})
          </p>
        </div>
        <div class="text-p2">
          {{ formatNumber(reward.apr) }}%
        </div>
      </div>
    </div>
    <div class="bg-surface-secondary rounded-12 p-16 flex justify-between items-center">
      <p>Total supply APY</p>
      <p class="text-h4">
        {{ formatNumber(totalSupplyApy) }}%
      </p>
    </div>
  </BaseModalWrapper>
</template>
