<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import { nanoToValue } from '~/utils/crypto-utils'

const { isConnected } = useAccount()
const { rewards, isRewardsLoading } = useMerkl()
const { userRewards: brevisRewards, isRewardsLoading: isBrevisRewardsLoading } = useBrevis()
const { locks, isLocksLoading } = useREULLocks()

const sortedRewards = computed(() => {
  return [...rewards.value].sort((a, b) => {
    const aUsd = (nanoToValue(a.amount, a.token.decimals) - nanoToValue(a.claimed, a.token.decimals)) * (a.token.price || 0)
    const bUsd = (nanoToValue(b.amount, b.token.decimals) - nanoToValue(b.claimed, b.token.decimals)) * (b.token.price || 0)
    return bUsd - aUsd
  })
})

const sortedBrevisRewards = computed(() => {
  return [...brevisRewards.value].sort((a, b) => {
    const aUsd = (Number.parseFloat(a.reward_info.reward_amt) || 0) * (Number.parseFloat(a.reward_info.reward_usd_price) || 0)
    const bUsd = (Number.parseFloat(b.reward_info.reward_amt) || 0) * (Number.parseFloat(b.reward_info.reward_usd_price) || 0)
    return bUsd - aUsd
  })
})
</script>

<template>
  <div class="flex flex-col flex-1">
    <!-- Merkl rewards -->
    <div>
      <div class="px-20 py-16 border-b border-line-default">
        <h2 class="text-h2 text-content-primary mb-4">
          Rewards via Merkl
        </h2>
        <p class="text-p3 text-content-tertiary">
          Rewards distributed via Merkl, with updates every 8–12 hours.
        </p>
      </div>
      <div
        v-if="isRewardsLoading"
        class="flex justify-center items-center py-32"
      >
        <UiLoader class="text-content-tertiary" />
      </div>
      <div
        v-else-if="rewards.length === 0"
        class="flex justify-center items-center py-32"
      >
        <div class="flex flex-col gap-8 items-center text-content-tertiary">
          <div class="flex w-48 h-48 justify-center items-center rounded-12 bg-surface-secondary">
            <SvgIcon name="search" />
          </div>
          <template v-if="isConnected">
            You don't have rewards yet
          </template>
          <template v-else>
            Connect your wallet to see your rewards
          </template>
        </div>
      </div>
      <div
        v-else
        class="grid grid-cols-3 laptop:grid-cols-2 mobile:grid-cols-1 gap-12 p-16"
      >
        <PortfolioRewardItem
          v-for="(reward, idx) in sortedRewards"
          :key="`reward-${idx}`"
          :reward="reward"
        />
      </div>
    </div>

    <!-- Incentra rewards -->
    <div class="border-t border-line-default">
      <div class="px-20 py-16 border-b border-line-default">
        <h2 class="text-h2 text-content-primary mb-4">
          Rewards via Incentra
        </h2>
        <p class="text-p3 text-content-tertiary">
          Rewards distributed via Incentra incentive campaigns.
        </p>
      </div>
      <div
        v-if="isBrevisRewardsLoading"
        class="flex justify-center items-center py-32"
      >
        <UiLoader class="text-content-tertiary" />
      </div>
      <div
        v-else-if="brevisRewards.length === 0"
        class="flex justify-center items-center py-32"
      >
        <div class="flex flex-col gap-8 items-center text-content-tertiary">
          <div class="flex w-48 h-48 justify-center items-center rounded-12 bg-surface-secondary">
            <SvgIcon name="search" />
          </div>
          <template v-if="isConnected">
            You don't have rewards yet
          </template>
          <template v-else>
            Connect your wallet to see your rewards
          </template>
        </div>
      </div>
      <div
        v-else
        class="grid grid-cols-3 laptop:grid-cols-2 mobile:grid-cols-1 gap-12 p-16"
      >
        <PortfolioBrevisRewardItem
          v-for="(campaign, idx) in sortedBrevisRewards"
          :key="`brevis-${idx}`"
          :campaign="campaign"
        />
      </div>
    </div>

    <!-- rEUL locks -->
    <div class="border-t border-line-default">
      <div class="px-20 py-16 border-b border-line-default">
        <h2 class="text-h2 text-content-primary mb-4">
          Rewards in EUL (rEUL)
        </h2>
        <p class="text-p3 text-content-tertiary">
          All claimed rEUL vest over a 6-month period which starts upon claiming, allowing a 1:1 exchange for EUL at the end.
          Early unlocking reduces your amount.
        </p>
      </div>
      <div
        v-if="isLocksLoading"
        class="flex justify-center items-center py-32"
      >
        <UiLoader class="text-content-tertiary" />
      </div>
      <div
        v-else-if="locks.length === 0"
        class="flex justify-center items-center py-32"
      >
        <div class="flex flex-col gap-8 items-center text-content-tertiary">
          <div class="flex w-48 h-48 justify-center items-center rounded-12 bg-surface-secondary">
            <SvgIcon name="search" />
          </div>
          <template v-if="isConnected">
            You don't have locks yet
          </template>
          <template v-else>
            Connect your wallet to see your locks
          </template>
        </div>
      </div>
      <div
        v-else
        class="grid grid-cols-3 laptop:grid-cols-2 mobile:grid-cols-1 gap-12 p-16"
      >
        <RewardUnlockList :items="locks" />
      </div>
    </div>
  </div>
</template>
