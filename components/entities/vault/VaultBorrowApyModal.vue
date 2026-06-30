<script setup lang="ts">
import { formatNumber } from '~/utils/string-utils'
import { combineApyWithIntrinsic } from '~/utils/vault-intrinsic-apy'
import type { RewardCampaign } from '~/entities/reward-campaign'
import { PROVIDER_LABELS, PROVIDER_LOGOS, rewardCampaignAprPercent, rewardCampaignDisplays } from '~/entities/reward-campaign'
import type { IntrinsicApyInfo } from '@eulerxyz/euler-v2-sdk'

const emits = defineEmits(['close'])
const { borrowingAPY, intrinsicAPY, intrinsicApyInfo, campaigns, rewardVaultAddress, inline = false, close = true } = defineProps<{
  borrowingAPY: number
  intrinsicAPY?: number
  intrinsicApyInfo?: IntrinsicApyInfo
  campaigns?: RewardCampaign[]
  rewardVaultAddress?: string
  inline?: boolean
  close?: boolean
}>()

const rewardsTotalAPY = computed(() => {
  if (!campaigns || campaigns.length === 0) return null
  const total = campaigns.reduce((sum, c) => sum + rewardCampaignAprPercent(c), 0)
  return total > 0 ? total : null
})

const intrinsicApyValue = computed(() => intrinsicAPY ?? 0)
const hasIntrinsicApy = computed(() => intrinsicApyValue.value > 0)
const totalBorrowApy = computed(() => combineApyWithIntrinsic(borrowingAPY, intrinsicApyValue.value) - (rewardsTotalAPY.value || 0))

const rewardsInfo = computed(() => {
  return rewardCampaignDisplays(campaigns, 'borrow', rewardVaultAddress)
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
          <div
            class="text-h5"
            data-id="data-point"
            data-field="borrow-apy-base"
            :data-value="borrowingAPY"
          >
            {{ formatNumber(borrowingAPY) }}%
          </div>
        </div>
        <div
          v-if="hasIntrinsicApy"
          class="flex justify-between items-start gap-24 mt-16"
        >
          <div>
            <p class="mb-4">
              Intrinsic APY<span
                v-if="intrinsicApyInfo?.provider"
                data-id="data-point"
                data-field="borrow-apy-intrinsic-provider"
                :data-value="intrinsicApyInfo.provider"
              > ({{ intrinsicApyInfo.provider }})</span>
            </p>
            <p class="text-content-primary">
              Yield intrinsic to the borrowed asset, such as staking yield, which increases effective borrowing cost
            </p>
            <a
              v-if="intrinsicApyInfo?.source"
              :href="intrinsicApyInfo.source"
              target="_blank"
              rel="noopener noreferrer"
              class="text-sm text-content-primary underline mt-4 inline-block"
              data-id="data-point"
              data-field="borrow-apy-intrinsic-source"
              :data-value="intrinsicApyInfo.source"
            >
              Source
            </a>
          </div>
          <div
            class="text-h5 shrink-0"
            data-id="data-point"
            data-field="borrow-apy-intrinsic"
            :data-value="intrinsicApyValue"
          >
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
        <div
          class="text-h5"
          data-id="data-point"
          data-field="borrow-apy-rewards-total"
          :data-value="rewardsTotalAPY"
        >
          - {{ formatNumber(rewardsTotalAPY) }}%
        </div>
      </div>
      <div
        v-if="rewardsInfo.length > 0"
        data-id="borrow-apy-reward-campaigns"
        data-list="borrow-apy-reward-campaigns"
        :data-count="rewardsInfo.length"
        :data-rendered-count="rewardsInfo.length"
      >
        <div
          v-for="reward in rewardsInfo"
          :key="reward.id"
          class="flex justify-between items-center mb-16"
          data-id="borrow-apy-reward-campaign"
          data-list="borrow-apy-reward-campaigns"
          :data-key="reward.parityKey"
        >
          <div class="flex">
            <img
              v-if="reward.rewardToken.icon"
              class="w-20 h-20"
              :src="reward.rewardToken.icon"
              alt="Reward token logo"
            >
            <p
              class="ml-12"
              data-id="data-point"
              :data-key="reward.parityKey"
              data-field="borrow-apy-reward-token"
              :data-value="reward.rewardToken.symbol"
            >
              {{ reward.rewardToken.symbol }}
            </p>
            <p class="ml-4 text-content-primary">
              (<a
                v-if="reward.sourceUrl"
                :href="reward.sourceUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="underline"
                data-id="data-point"
                :data-key="reward.parityKey"
                data-field="borrow-apy-reward-provider"
                :data-value="PROVIDER_LABELS[reward.source] || reward.source"
                @click.stop
              ><img
                v-if="PROVIDER_LOGOS[reward.source]"
                :src="PROVIDER_LOGOS[reward.source]"
                class="w-14 h-14 inline-block align-middle mr-2 bg-white rounded-sm p-1"
                :alt="PROVIDER_LABELS[reward.source]"
              >{{ PROVIDER_LABELS[reward.source] || reward.source }}</a><span
                v-else
                data-id="data-point"
                :data-key="reward.parityKey"
                data-field="borrow-apy-reward-provider"
                :data-value="PROVIDER_LABELS[reward.source] || reward.source"
              >
                <img
                  v-if="PROVIDER_LOGOS[reward.source]"
                  :src="PROVIDER_LOGOS[reward.source]"
                  class="w-14 h-14 inline-block align-middle mr-2 bg-white rounded-sm p-1"
                  :alt="PROVIDER_LABELS[reward.source]"
                >{{ PROVIDER_LABELS[reward.source] || reward.source }}
              </span><span
                v-if="reward.isCollateralSpecific"
                data-id="data-point"
                :data-key="reward.parityKey"
                data-field="borrow-apy-reward-type"
                data-value="collateral bonus"
              >, collateral bonus</span><span
                v-if="reward.endDate"
                data-id="data-point"
                :data-key="reward.parityKey"
                data-field="borrow-apy-reward-end-date"
                :data-value="reward.endDate.toFormat('MMMM dd, yyyy')"
              >, ends {{ reward.endDate.toFormat('MMMM dd, yyyy') }}</span>)
            </p>
          </div>
          <div
            class="text-p2"
            data-id="data-point"
            :data-key="reward.parityKey"
            data-field="borrow-apy-reward-apr"
            :data-value="reward.apr"
          >
            {{ formatNumber(reward.apr) }}%
          </div>
        </div>
      </div>
    </div>
    <div class="bg-surface-secondary rounded-12 p-16 flex justify-between items-center">
      <p>Total borrow APY</p>
      <p
        class="text-h4"
        data-id="data-point"
        data-field="borrow-apy-total"
        :data-value="totalBorrowApy"
      >
        {{ formatNumber(totalBorrowApy) }}%
      </p>
    </div>
  </BaseModalWrapper>
</template>
