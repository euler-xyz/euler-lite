<script setup lang="ts">
import { formatNumber } from '~/utils/string-utils'
import { PROVIDER_LABELS, PROVIDER_LOGOS, rewardCampaignDisplays } from '~/entities/reward-campaign'

const emits = defineEmits(['close'])
const {
  maxRoe,
  maxMultiplier,
  supplyAPY,
  borrowAPY,
  borrowLTV,
  borrowVaultAddress,
  collateralAddress,
  inline = false,
  close = true,
} = defineProps<{
  maxRoe: number
  maxMultiplier: number
  supplyAPY: number
  borrowAPY: number
  borrowLTV: number
  borrowVaultAddress?: string
  collateralAddress?: string
  isBestInMarket?: boolean
  inline?: boolean
  close?: boolean
}>()

const { getLoopingRewardApy, getLoopingRewardCampaigns, getSupplyRewardApy, getBorrowRewardApy, getSupplyRewardCampaigns, getBorrowRewardCampaigns } = useRewardsApy()

const loopingRewardAPR = computed(() =>
  borrowVaultAddress && collateralAddress
    ? getLoopingRewardApy(borrowVaultAddress, collateralAddress)
    : 0,
)

const loopingCampaigns = computed(() => {
  if (!borrowVaultAddress || !collateralAddress) return []
  return rewardCampaignDisplays(getLoopingRewardCampaigns(borrowVaultAddress, collateralAddress), 'looping')
})

const supplyCampaigns = computed(() => {
  if (!collateralAddress) return []
  return rewardCampaignDisplays(getSupplyRewardCampaigns(collateralAddress), 'supply')
})

const borrowCampaigns = computed(() => {
  if (!borrowVaultAddress || !collateralAddress) return []
  return rewardCampaignDisplays(getBorrowRewardCampaigns(borrowVaultAddress, collateralAddress), 'borrow')
})

const supplyRewardAPY = computed(() =>
  collateralAddress ? getSupplyRewardApy(collateralAddress) : 0,
)

const borrowRewardAPY = computed(() =>
  borrowVaultAddress && collateralAddress
    ? getBorrowRewardApy(borrowVaultAddress, collateralAddress)
    : 0,
)

const baseSupplyAPY = computed(() => supplyAPY - supplyRewardAPY.value)
const baseBorrowAPY = computed(() => borrowAPY + borrowRewardAPY.value)

const hasSupplyRewards = computed(() => supplyRewardAPY.value > 0)
const hasBorrowRewards = computed(() => borrowRewardAPY.value > 0)
const hasLooping = computed(() => loopingRewardAPR.value > 0)

const handleClose = () => {
  emits('close')
}
</script>

<template>
  <BaseModalWrapper
    title="Max ROE"
    :inline="inline"
    :close="close"
    @close="handleClose"
  >
    <p class="text-content-primary text-p3 mb-12">
      ROE (Return on Equity) estimates the annualized return on your own capital in a multiplied position. A positive ROE means the supply yield exceeds borrowing costs at the given multiplier. A negative ROE means the position is gradually losing value to interest costs.
      Max ROE is shown only when the collateral and debt assets share a correlated category, such as USD, ETH, or BTC. For uncorrelated pairs, Euler shows Net APY instead because ROE assumes the asset price ratio stays stable.
      <template v-if="isBestInMarket">
        The value shown is the max modelled ROE across correlated collateral/borrow pairs in this market. Not guaranteed. Borrowing and multiplied positions involve changing rates, liquidity constraints, and liquidation risk.
      </template>
    </p>
    <div class="mb-12">
      <div class="pb-16 mb-16 border-b border-line-default">
        <div class="flex justify-between items-center mb-16">
          <div>
            <p class="mb-4">
              Max LTV
            </p>
            <p class="text-content-primary">
              Maximum loan-to-value ratio
            </p>
          </div>
          <div class="text-h5">
            {{ formatNumber(borrowLTV, 2) }}%
          </div>
        </div>
        <div class="flex justify-between items-center mb-16">
          <div>
            <p class="mb-4">
              Max multiplier
            </p>
            <p class="text-content-primary">
              Max multiplier at max LTV
            </p>
          </div>
          <div class="text-h5">
            {{ formatNumber(maxMultiplier, 2, 2) }}x
          </div>
        </div>
        <div class="flex justify-between items-center mb-16">
          <div>
            <p class="mb-4">
              Supply APY
            </p>
            <p class="text-content-primary">
              Collateral yield (S)
            </p>
          </div>
          <div class="text-h5">
            {{ formatNumber(baseSupplyAPY) }}%
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
            + {{ formatNumber(supplyRewardAPY) }}%
          </div>
        </div>
        <div
          v-for="campaign in supplyCampaigns"
          :key="campaign.id"
          class="flex justify-between items-center mt-12"
        >
          <div class="flex">
            <img
              v-if="campaign.rewardToken.icon"
              class="w-20 h-20 rounded-full"
              :src="campaign.rewardToken.icon"
              alt="Reward token logo"
            >
            <p class="ml-12">
              {{ campaign.rewardToken.symbol }}
            </p>
            <p class="ml-4 text-content-primary">
              (<a
                v-if="campaign.sourceUrl"
                :href="campaign.sourceUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="underline"
                @click.stop
              ><img
                v-if="PROVIDER_LOGOS[campaign.source]"
                :src="PROVIDER_LOGOS[campaign.source]"
                class="w-14 h-14 inline-block align-middle mr-2 bg-white rounded-sm p-1"
                :alt="PROVIDER_LABELS[campaign.source]"
              >{{ PROVIDER_LABELS[campaign.source] || campaign.source }}</a><template v-else>
                <img
                  v-if="PROVIDER_LOGOS[campaign.source]"
                  :src="PROVIDER_LOGOS[campaign.source]"
                  class="w-14 h-14 inline-block align-middle mr-2 bg-white rounded-sm p-1"
                  :alt="PROVIDER_LABELS[campaign.source]"
                >{{ PROVIDER_LABELS[campaign.source] || campaign.source }}
              </template>{{ campaign.endDate ? `, ends ${campaign.endDate.toFormat('MMMM dd, yyyy')}` : '' }})
            </p>
          </div>
          <div class="text-p2">
            {{ formatNumber(campaign.apr) }}%
          </div>
        </div>
        <div class="flex justify-between items-center mt-16">
          <div>
            <p class="mb-4">
              Borrow APY
            </p>
            <p class="text-content-primary">
              Borrowing cost (B)
            </p>
          </div>
          <div class="text-h5">
            {{ formatNumber(baseBorrowAPY) }}%
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
            - {{ formatNumber(borrowRewardAPY) }}%
          </div>
        </div>
        <div
          v-for="campaign in borrowCampaigns"
          :key="campaign.id"
          class="flex justify-between items-center mt-12"
        >
          <div class="flex">
            <img
              v-if="campaign.rewardToken.icon"
              class="w-20 h-20 rounded-full"
              :src="campaign.rewardToken.icon"
              alt="Reward token logo"
            >
            <p class="ml-12">
              {{ campaign.rewardToken.symbol }}
            </p>
            <p class="ml-4 text-content-primary">
              (<a
                v-if="campaign.sourceUrl"
                :href="campaign.sourceUrl"
                target="_blank"
                rel="noopener noreferrer"
                class="underline"
                @click.stop
              ><img
                v-if="PROVIDER_LOGOS[campaign.source]"
                :src="PROVIDER_LOGOS[campaign.source]"
                class="w-14 h-14 inline-block align-middle mr-2 bg-white rounded-sm p-1"
                :alt="PROVIDER_LABELS[campaign.source]"
              >{{ PROVIDER_LABELS[campaign.source] || campaign.source }}</a><template v-else>
                <img
                  v-if="PROVIDER_LOGOS[campaign.source]"
                  :src="PROVIDER_LOGOS[campaign.source]"
                  class="w-14 h-14 inline-block align-middle mr-2 bg-white rounded-sm p-1"
                  :alt="PROVIDER_LABELS[campaign.source]"
                >{{ PROVIDER_LABELS[campaign.source] || campaign.source }}
              </template>{{ campaign.endDate ? `, ends ${campaign.endDate.toFormat('MMMM dd, yyyy')}` : '' }})
            </p>
          </div>
          <div class="text-p2">
            {{ formatNumber(campaign.apr) }}%
          </div>
        </div>
        <template v-if="hasLooping">
          <div class="flex justify-between items-center mt-16">
            <div>
              <p class="mb-4 flex gap-4">
                <SvgIcon
                  class="!w-20 !h-20 text-accent-500"
                  name="sparks"
                />
                <span>Looping reward (R)</span>
              </p>
              <p class="text-content-primary">
                Incentive on net liquidity
              </p>
            </div>
            <div class="text-h5">
              + {{ formatNumber(loopingRewardAPR) }}%
            </div>
          </div>
          <div
            v-for="campaign in loopingCampaigns"
            :key="campaign.id"
            class="mt-12"
          >
            <div class="flex justify-between items-center">
              <div class="flex ml-32">
                <img
                  v-if="campaign.rewardToken.icon"
                  class="w-20 h-20 rounded-full"
                  :src="campaign.rewardToken.icon"
                  alt="Reward token logo"
                >
                <p :class="campaign.rewardToken.icon ? 'ml-12' : ''">
                  {{ campaign.rewardToken.symbol }}
                </p>
                <p class="ml-4 text-content-primary">
                  (<a
                    v-if="campaign.sourceUrl"
                    :href="campaign.sourceUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                    class="underline"
                    @click.stop
                  ><img
                    v-if="PROVIDER_LOGOS[campaign.source]"
                    :src="PROVIDER_LOGOS[campaign.source]"
                    class="w-14 h-14 inline-block align-middle mr-2 bg-white rounded-sm p-1"
                    :alt="PROVIDER_LABELS[campaign.source]"
                  >{{ PROVIDER_LABELS[campaign.source] || campaign.source }}</a><template v-else>
                    <img
                      v-if="PROVIDER_LOGOS[campaign.source]"
                      :src="PROVIDER_LOGOS[campaign.source]"
                      class="w-14 h-14 inline-block align-middle mr-2 bg-white rounded-sm p-1"
                      :alt="PROVIDER_LABELS[campaign.source]"
                    >{{ PROVIDER_LABELS[campaign.source] || campaign.source }}
                  </template>{{ campaign.endDate ? `, ends ${campaign.endDate.toFormat('MMMM dd, yyyy')}` : '' }})
                </p>
              </div>
              <div class="text-p2">
                {{ formatNumber(campaign.apr) }}%
              </div>
            </div>
            <p
              v-if="campaign.minMultiplier || campaign.maxMultiplier"
              class="text-content-primary text-p4 mt-4 ml-32"
            >
              Requires multiplier
              <template v-if="campaign.minMultiplier && campaign.maxMultiplier">
                between {{ campaign.minMultiplier }}x and {{ campaign.maxMultiplier }}x
              </template>
              <template v-else-if="campaign.minMultiplier">
                of at least {{ campaign.minMultiplier }}x
              </template>
              <template v-else-if="campaign.maxMultiplier">
                of at most {{ campaign.maxMultiplier }}x
              </template>
            </p>
          </div>
          <p class="text-content-primary text-p4 mt-8">
            Looping reward is based on net liquidity and does not scale with multiplier.
          </p>
        </template>
      </div>
      <div class="flex justify-between items-center">
        <div>
          <p class="mb-4">
            Formula
          </p>
          <p class="text-content-primary">
            <template v-if="hasLooping">
              M &times; S - (M - 1) &times; B + R = ROE
            </template>
            <template v-else>
              M &times; S - (M - 1) &times; B = ROE
            </template>
          </p>
        </div>
      </div>
    </div>

    <div class="bg-surface-secondary rounded-8 px-12 py-10 flex justify-between items-center gap-16">
      <div>
        <p>Max ROE</p>
        <p class="text-content-primary text-p3">
          Maximum return on equity at max multiplier
        </p>
      </div>
      <p
        class="text-h4"
        :class="[maxRoe >= 0 ? 'text-accent-600' : 'text-error-500']"
      >
        = {{ formatNumber(maxRoe) }}%
      </p>
    </div>
  </BaseModalWrapper>
</template>
