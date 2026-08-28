<script setup lang="ts">
import { formatNumber } from '~/utils/string-utils'
import { combineApyWithIntrinsic } from '~/utils/vault-intrinsic-apy'
import type { RewardCampaign } from '~/entities/reward-campaign'
import { PROVIDER_LABELS, PROVIDER_LOGOS, rewardCampaignAprPercent, rewardCampaignDisplays } from '~/entities/reward-campaign'
import type { IntrinsicApyInfo } from '@eulerxyz/euler-v2-sdk'

const emits = defineEmits(['close'])
const { mode, borrowingAPY, lendingAPY, intrinsicAPY, intrinsicApyInfo, campaigns, totalSupplyAPY, baseApyAverageLabel, rewardVaultAddress, inline = false, close = true } = defineProps<{
  mode: 'borrow' | 'supply'
  borrowingAPY?: number
  lendingAPY?: number
  intrinsicAPY?: number
  intrinsicApyInfo?: IntrinsicApyInfo
  campaigns?: RewardCampaign[]
  totalSupplyAPY?: number
  baseApyAverageLabel?: string
  rewardVaultAddress?: string
  inline?: boolean
  close?: boolean
}>()

const isBorrow = computed(() => mode === 'borrow')
const prefix = computed(() => (isBorrow.value ? 'borrow' : 'supply'))
const baseAPY = computed(() => (isBorrow.value ? borrowingAPY ?? 0 : lendingAPY ?? 0))

const rewardsTotalAPY = computed(() => {
  if (!campaigns || campaigns.length === 0) return null
  const total = campaigns.reduce((sum, c) => sum + rewardCampaignAprPercent(c), 0)
  return total > 0 ? total : null
})

const intrinsicApyValue = computed(() => intrinsicAPY ?? 0)
const hasIntrinsicApy = computed(() => intrinsicApyValue.value > 0)
const totalApy = computed(() => {
  if (isBorrow.value) {
    return combineApyWithIntrinsic(baseAPY.value, intrinsicApyValue.value) - (rewardsTotalAPY.value || 0)
  }
  return totalSupplyAPY ?? combineApyWithIntrinsic(baseAPY.value, intrinsicApyValue.value) + (rewardsTotalAPY.value || 0)
})

const rewardsInfo = computed(() => {
  return rewardCampaignDisplays(campaigns, mode, rewardVaultAddress)
})

const handleClose = () => {
  emits('close')
}
</script>

<template>
  <BaseModalWrapper
    :title="isBorrow ? 'Borrow APY' : 'Supply APY'"
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
            <p
              v-if="isBorrow"
              class="mb-4"
            >
              Borrowing APY
            </p>
            <p
              v-else
              class="mb-4 flex items-center gap-6"
            >
              Lending APY
              <span
                v-if="baseApyAverageLabel"
                class="inline-flex items-center rounded-8 px-8 py-2 bg-accent-100 text-accent-600 text-p5"
                data-id="data-point"
                data-field="supply-apy-base-average-label"
                :data-value="baseApyAverageLabel"
              >
                {{ baseApyAverageLabel }}
              </span>
            </p>
            <p class="text-content-primary">
              {{ isBorrow ? 'Cost of borrowing on Euler' : 'Yield from lending on Euler' }}
            </p>
          </div>
          <div
            class="text-h5"
            data-id="data-point"
            :data-field="`${prefix}-apy-base`"
            :data-value="baseAPY"
          >
            {{ formatNumber(baseAPY) }}%
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
                :data-field="`${prefix}-apy-intrinsic-provider`"
                :data-value="intrinsicApyInfo.provider"
              > ({{ intrinsicApyInfo.provider }})</span>
            </p>
            <p class="text-content-primary">
              {{ isBorrow
                ? 'Yield intrinsic to the borrowed asset, such as staking yield, which increases effective borrowing cost'
                : 'Yield intrinsic to the supplied asset, such as staking yield or external rewards, might be compounded with lending yield' }}
            </p>
            <a
              v-if="intrinsicApyInfo?.source"
              :href="intrinsicApyInfo.source"
              target="_blank"
              rel="noopener noreferrer"
              class="text-sm text-content-primary underline mt-4 inline-block"
              data-id="data-point"
              :data-field="`${prefix}-apy-intrinsic-source`"
              :data-value="intrinsicApyInfo.source"
            >
              Source
            </a>
          </div>
          <div
            class="text-h5 shrink-0"
            data-id="data-point"
            :data-field="`${prefix}-apy-intrinsic`"
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
          :data-field="`${prefix}-apy-rewards-total`"
          :data-value="rewardsTotalAPY"
        >
          {{ isBorrow ? '-' : '+' }} {{ formatNumber(rewardsTotalAPY) }}%
        </div>
      </div>
      <div
        v-if="rewardsInfo.length > 0"
        :data-id="`${prefix}-apy-reward-campaigns`"
        :data-list="`${prefix}-apy-reward-campaigns`"
        :data-count="rewardsInfo.length"
        :data-rendered-count="rewardsInfo.length"
      >
        <div
          v-for="reward in rewardsInfo"
          :key="reward.id"
          class="flex justify-between items-center mb-16"
          :data-id="`${prefix}-apy-reward-campaign`"
          :data-list="`${prefix}-apy-reward-campaigns`"
          :data-key="reward.parityKey"
        >
          <div class="flex">
            <img
              v-if="reward.rewardToken.icon"
              class="w-20 h-20"
              :class="{ 'rounded-full': !isBorrow }"
              :src="reward.rewardToken.icon"
              alt="Reward token logo"
            >
            <p
              class="ml-12"
              data-id="data-point"
              :data-key="reward.parityKey"
              :data-field="`${prefix}-apy-reward-token`"
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
                :data-field="`${prefix}-apy-reward-provider`"
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
                :data-field="`${prefix}-apy-reward-provider`"
                :data-value="PROVIDER_LABELS[reward.source] || reward.source"
              >
                <img
                  v-if="PROVIDER_LOGOS[reward.source]"
                  :src="PROVIDER_LOGOS[reward.source]"
                  class="w-14 h-14 inline-block align-middle mr-2 bg-white rounded-sm p-1"
                  :alt="PROVIDER_LABELS[reward.source]"
                >{{ PROVIDER_LABELS[reward.source] || reward.source }}
              </span><span
                v-if="isBorrow && reward.isCollateralSpecific"
                data-id="data-point"
                :data-key="reward.parityKey"
                data-field="borrow-apy-reward-type"
                data-value="collateral bonus"
              >, collateral bonus</span><span
                v-if="reward.eligibilityLabel"
                data-id="data-point"
                :data-key="reward.parityKey"
                :data-field="`${prefix}-apy-reward-eligibility`"
                :data-value="reward.eligibilityLabel"
              >, {{ reward.eligibilityLabel }}</span><span
                v-if="reward.endDate"
                data-id="data-point"
                :data-key="reward.parityKey"
                :data-field="`${prefix}-apy-reward-end-date`"
                :data-value="reward.endDate.toFormat('MMMM dd, yyyy')"
              >, ends {{ reward.endDate.toFormat('MMMM dd, yyyy') }}</span>)
            </p>
          </div>
          <div
            class="text-p2"
            data-id="data-point"
            :data-key="reward.parityKey"
            :data-field="`${prefix}-apy-reward-apr`"
            :data-value="reward.apr"
          >
            {{ formatNumber(reward.apr) }}%
          </div>
        </div>
      </div>
    </div>
    <div class="bg-surface-secondary rounded-12 p-16 flex justify-between items-center">
      <p>{{ isBorrow ? 'Total borrow APY' : 'Total supply APY' }}</p>
      <p
        class="text-h4"
        data-id="data-point"
        :data-field="`${prefix}-apy-total`"
        :data-value="totalApy"
      >
        {{ formatNumber(totalApy) }}%
      </p>
    </div>
  </BaseModalWrapper>
</template>
