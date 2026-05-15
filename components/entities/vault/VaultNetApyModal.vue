<script setup lang="ts">
import { DateTime } from 'luxon'
import { formatNumber } from '~/utils/string-utils'
import type { RewardCampaign } from '~/entities/reward-campaign'
import { PROVIDER_LABELS, PROVIDER_LOGOS } from '~/entities/reward-campaign'

const emits = defineEmits(['close'])
const {
  baseSupplyAPY,
  baseBorrowAPY,
  intrinsicSupplyAPY,
  intrinsicBorrowAPY,
  supplyRewardAPY,
  borrowRewardAPY,
  loopingRewardAPY,
  loopingEligible,
  netAPY,
  supplyCampaigns,
  borrowCampaigns,
  loopingCampaigns,
  inline = false,
  close = true,
} = defineProps<{
  supplyUSD: number
  borrowUSD: number
  baseSupplyAPY: number
  baseBorrowAPY: number
  intrinsicSupplyAPY?: number
  intrinsicBorrowAPY?: number
  supplyRewardAPY?: number | null
  borrowRewardAPY?: number | null
  loopingRewardAPY?: number | null
  loopingEligible?: boolean
  netAPY: number
  supplyCampaigns?: RewardCampaign[]
  borrowCampaigns?: RewardCampaign[]
  loopingCampaigns?: RewardCampaign[]
  inline?: boolean
  close?: boolean
}>()

const hasIntrinsicSupply = computed(() => (intrinsicSupplyAPY ?? 0) !== 0)
const hasIntrinsicBorrow = computed(() => (intrinsicBorrowAPY ?? 0) !== 0)
const hasSupplyRewards = computed(() => (supplyRewardAPY || 0) > 0)
const hasBorrowRewards = computed(() => (borrowRewardAPY || 0) > 0)
const hasLoopingCampaigns = computed(() => loopingRewardsInfo.value.length > 0)

const mapCampaigns = (campaigns: RewardCampaign[] | undefined, side: string) => {
  if (!campaigns) return []
  const now = Math.floor(Date.now() / 1000)
  return campaigns
    .filter(c => c.endTimestamp > now || c.endTimestamp === 0)
    .map(c => ({
      id: `${side}-${c.vault}-${c.provider}-${c.type}-${c.endTimestamp}`,
      apr: c.apr,
      endDate: c.endTimestamp > 0 ? DateTime.fromSeconds(c.endTimestamp) : null,
      rewardToken: c.rewardToken || { symbol: 'Unknown', icon: '' },
      source: c.provider,
      sourceUrl: c.sourceUrl,
      minMultiplier: c.minMultiplier,
      maxMultiplier: c.maxMultiplier,
    }))
    .sort((a, b) => a.rewardToken.symbol.localeCompare(b.rewardToken.symbol))
}

const supplyRewardsInfo = computed(() => mapCampaigns(supplyCampaigns, 'supply'))
const borrowRewardsInfo = computed(() => mapCampaigns(borrowCampaigns, 'borrow'))
const loopingRewardsInfo = computed(() => mapCampaigns(loopingCampaigns, 'looping'))

const handleClose = () => {
  emits('close')
}
</script>

<template>
  <BaseModalWrapper
    title="Net APY"
    :inline="inline"
    :close="close"
    @close="handleClose"
  >
    <p class="text-content-primary text-p3 mb-16">
      Net APY estimates the annualized return on your supplied collateral after accounting for borrowing costs and any reward incentives. A positive net APY means the combined yield exceeds the cost of borrowing. A negative net APY means borrowing costs outweigh the yield.
    </p>
    <div class="mb-24">
      <div class="pb-16 mb-16 border-b border-line-default">
        <div class="flex justify-between items-center">
          <div>
            <p class="mb-4">
              Supply APY
            </p>
            <p class="text-content-primary">
              Yield from lending collateral on Euler
            </p>
          </div>
          <div class="text-h5">
            + {{ formatNumber(baseSupplyAPY) }}%
          </div>
        </div>
        <div
          v-if="hasIntrinsicSupply"
          class="flex justify-between items-center mt-16"
        >
          <div>
            <p class="mb-4">
              Intrinsic supply APY
            </p>
            <p class="text-content-primary">
              Yield intrinsic to the collateral asset
            </p>
          </div>
          <div class="text-h5">
            + {{ formatNumber(intrinsicSupplyAPY) }}%
          </div>
        </div>
        <div
          v-if="hasSupplyRewards"
          class="flex justify-between items-center mt-16"
        >
          <div>
            <p class="mb-4 flex gap-4">
              <SvgIcon
                class="!w-20 !h-20 text-accent-500"
                name="sparks"
              />
              <span>Supply rewards APY</span>
            </p>
          </div>
          <div class="text-h5">
            + {{ formatNumber(supplyRewardAPY ?? 0) }}%
          </div>
        </div>
        <div
          v-for="reward in supplyRewardsInfo"
          :key="reward.id"
          class="flex justify-between items-center mt-12"
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
      <div class="pb-16 mb-16 border-b border-line-default">
        <div class="flex justify-between items-center">
          <div>
            <p class="mb-4">
              Borrow APY
            </p>
            <p class="text-content-primary">
              Cost of borrowing on Euler
            </p>
          </div>
          <div class="text-h5">
            - {{ formatNumber(baseBorrowAPY) }}%
          </div>
        </div>
        <div
          v-if="hasIntrinsicBorrow"
          class="flex justify-between items-center mt-16"
        >
          <div>
            <p class="mb-4">
              Intrinsic borrow APY
            </p>
            <p class="text-content-primary">
              Yield intrinsic to the borrowed asset
            </p>
          </div>
          <div class="text-h5">
            - {{ formatNumber(intrinsicBorrowAPY) }}%
          </div>
        </div>
        <div
          v-if="hasBorrowRewards"
          class="flex justify-between items-center mt-16"
        >
          <div>
            <p class="mb-4 flex gap-4">
              <SvgIcon
                class="!w-20 !h-20 text-accent-500"
                name="sparks"
              />
              <span>Borrow rewards APY</span>
            </p>
          </div>
          <div class="text-h5">
            - {{ formatNumber(borrowRewardAPY ?? 0) }}%
          </div>
        </div>
        <div
          v-for="reward in borrowRewardsInfo"
          :key="reward.id"
          class="flex justify-between items-center mt-12"
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
      <div
        v-if="hasLoopingCampaigns"
        class="pb-16 mb-16 border-b border-line-default"
      >
        <div class="flex justify-between items-center">
          <div>
            <p class="mb-4 flex gap-4">
              <SvgIcon
                class="!w-20 !h-20 text-accent-500"
                name="sparks"
              />
              <span>Looping reward APY</span>
            </p>
            <p class="text-content-primary">
              Incentive on net liquidity
            </p>
          </div>
          <div class="text-h5">
            + {{ formatNumber(loopingRewardAPY ?? 0) }}%
          </div>
        </div>
        <div
          v-for="reward in loopingRewardsInfo"
          :key="reward.id"
          class="mt-12"
        >
          <div class="flex justify-between items-center">
            <div class="flex ml-32">
              <img
                v-if="reward.rewardToken.icon"
                class="w-20 h-20 rounded-full"
                :src="reward.rewardToken.icon"
                alt="Reward token logo"
              >
              <p :class="reward.rewardToken.icon ? 'ml-12' : ''">
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
          <p
            v-if="reward.minMultiplier || reward.maxMultiplier"
            class="text-content-primary text-p4 mt-4 ml-32"
          >
            Requires multiplier
            <template v-if="reward.minMultiplier && reward.maxMultiplier">
              between {{ reward.minMultiplier }}x and {{ reward.maxMultiplier }}x
            </template>
            <template v-else-if="reward.minMultiplier">
              of at least {{ reward.minMultiplier }}x
            </template>
            <template v-else-if="reward.maxMultiplier">
              of at most {{ reward.maxMultiplier }}x
            </template>
          </p>
        </div>
        <p
          v-if="loopingEligible === false"
          class="text-warning-500 text-p4 mt-8"
        >
          Your current multiplier does not meet the requirements for this reward. Adjust your position to qualify.
        </p>
        <p class="text-content-primary text-p4 mt-8">
          Looping reward is based on net liquidity and does not scale with multiplier.
        </p>
      </div>
    </div>
    <div class="bg-surface-secondary rounded-12 p-16 flex justify-between items-center">
      <div>
        <p>Net APY</p>
        <p class="text-content-primary text-p3">
          Return on supplied collateral after borrow costs
        </p>
      </div>
      <p
        class="text-h4"
        :class="[netAPY >= 0 ? 'text-accent-600' : 'text-error-500']"
      >
        = {{ formatNumber(netAPY) }}%
      </p>
    </div>
  </BaseModalWrapper>
</template>
