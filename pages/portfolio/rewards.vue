<script setup lang="ts">
import { formatUnits } from 'viem'
import type { UserReward } from '~/entities/reward-campaign'

const { isConnected } = useWagmi()
const { isSpyMode } = useSpyMode()
const { enableMerkl, enableIncentra, enableFuul, enableTurtle } = useDeployConfig()
const { rewards, isRewardsLoading } = useSdkRewards()
const { locks, isLocksLoading } = useREULLocks()

const getRewardUsdValue = (reward: UserReward) =>
  Number(formatUnits(BigInt(reward.unclaimed), reward.token.decimals)) * reward.tokenPrice

const sortRewardsByUsd = (items: UserReward[]) =>
  [...items].sort((a, b) => getRewardUsdValue(b) - getRewardUsdValue(a))

const sortedMerklRewards = computed(() => sortRewardsByUsd(rewards.value.filter(reward => reward.provider === 'merkl')))
const sortedBrevisRewards = computed(() => sortRewardsByUsd(rewards.value.filter(reward => reward.provider === 'brevis')))
const sortedFuulRewards = computed(() => sortRewardsByUsd(rewards.value.filter(reward => reward.provider === 'fuul')))
const sortedTurtleRewards = computed(() => sortRewardsByUsd(rewards.value.filter(reward => reward.provider === 'turtle')))
const hasActiveSession = computed(() => isConnected.value || isSpyMode.value)
</script>

<template>
  <div class="flex flex-col flex-1 mx-16 rounded-12">
    <div>
      <template v-if="enableMerkl">
        <div class="flex justify-between items-center mb-8">
          <h3 class="text-h3 font-normal text-neutral-800">
            Rewards via Merkl
          </h3>
        </div>
        <p class="text-p2 text-neutral-500 mb-16">
          Updated every 8-12 hours
        </p>
        <div class="flex flex-1 rounded-12 p-8 mb-16 border border-line-default bg-card">
          <div
            v-if="isRewardsLoading"
            class="flex flex-1 min-h-[100px] justify-center items-center"
          >
            <UiLoader class="text-neutral-500" />
          </div>
          <div
            v-else-if="sortedMerklRewards.length === 0"
            class="flex flex-1 min-h-[100px] justify-center items-center py-32"
          >
            <PortfolioEmptyState
              :active="hasActiveSession"
              active-text="You don't have rewards yet"
              inactive-text="Connect your wallet to see your rewards"
            />
          </div>
          <div
            v-else
            class="flex-1 min-h-[100px]"
          >
            <PortfolioList
              :items="sortedMerklRewards"
              type="sdk-rewards"
            />
          </div>
        </div>
      </template>

      <template v-if="enableIncentra">
        <div class="flex justify-between items-center mb-8">
          <h3 class="text-h3 font-normal text-neutral-800">
            Rewards via Incentra
          </h3>
        </div>
        <div class="flex flex-1 rounded-12 p-8 mb-16 border border-line-default bg-card">
          <div
            v-if="isRewardsLoading"
            class="flex flex-1 min-h-[100px] justify-center items-center"
          >
            <UiLoader class="text-neutral-500" />
          </div>
          <div
            v-else-if="sortedBrevisRewards.length === 0"
            class="flex flex-1 min-h-[100px] justify-center items-center py-32"
          >
            <PortfolioEmptyState
              :active="hasActiveSession"
              active-text="You don't have rewards yet"
              inactive-text="Connect your wallet to see your rewards"
            />
          </div>
          <div
            v-else
            class="flex-1 min-h-[100px]"
          >
            <PortfolioList
              :items="sortedBrevisRewards"
              type="sdk-rewards"
            />
          </div>
        </div>
      </template>

      <template v-if="enableFuul">
        <div class="flex justify-between items-center mb-8">
          <h3 class="text-h3 font-normal text-neutral-800">
            Rewards via Fuul
          </h3>
        </div>
        <div class="flex flex-1 rounded-12 p-8 mb-16 border border-line-default bg-card">
          <div
            v-if="isRewardsLoading"
            class="flex flex-1 min-h-[100px] justify-center items-center"
          >
            <UiLoader class="text-neutral-500" />
          </div>
          <div
            v-else-if="sortedFuulRewards.length === 0"
            class="flex flex-1 min-h-[100px] justify-center items-center py-32"
          >
            <PortfolioEmptyState
              :active="hasActiveSession"
              active-text="You don't have rewards yet"
              inactive-text="Connect your wallet to see your rewards"
            />
          </div>
          <div
            v-else
            class="flex-1 min-h-[100px]"
          >
            <PortfolioList
              :items="sortedFuulRewards"
              type="sdk-rewards"
            />
          </div>
        </div>
      </template>

      <template v-if="enableTurtle">
        <div class="flex justify-between items-center mb-8">
          <h3 class="text-h3 font-normal text-neutral-800">
            Rewards via Turtle
          </h3>
        </div>
        <div class="flex flex-1 rounded-12 p-8 mb-16 border border-line-default bg-card">
          <div
            v-if="isRewardsLoading"
            class="flex flex-1 min-h-[100px] justify-center items-center"
          >
            <UiLoader class="text-neutral-500" />
          </div>
          <div
            v-else-if="sortedTurtleRewards.length === 0"
            class="flex flex-1 min-h-[100px] justify-center items-center py-32"
          >
            <PortfolioEmptyState
              :active="hasActiveSession"
              active-text="You don't have rewards yet"
              inactive-text="Connect your wallet to see your rewards"
            />
          </div>
          <div
            v-else
            class="flex-1 min-h-[100px]"
          >
            <PortfolioList
              :items="sortedTurtleRewards"
              type="sdk-rewards"
            />
          </div>
        </div>
      </template>

      <h3 class="text-h3 font-normal mb-8 text-neutral-800">
        Rewards in EUL (rEUL)
      </h3>
      <p class="text-p2 text-neutral-500 mb-16">
        All claimed rEUL vest over a 6-month period which starts upon claiming, allowing a 1:1 exchange for EUL at the end. <br>
        Early unlocking reduces your amount.
      </p>
      <div class="p-8 rounded-12 border border-line-default bg-card">
        <div
          v-if="isLocksLoading"
          class="flex flex-1 min-h-[100px] justify-center items-center"
        >
          <UiLoader class="text-neutral-500" />
        </div>
        <div
          v-else-if="locks.length === 0"
          class="flex flex-1 min-h-[100px] justify-center items-center"
        >
          <PortfolioEmptyState
            :active="hasActiveSession"
            active-text="You don't have locks yet"
            inactive-text="Connect your wallet to see your locks"
          />
        </div>
        <div
          v-else
          class="text-neutral-800 rounded-12"
        >
          <RewardUnlockList :items="locks" />
        </div>
      </div>
    </div>
  </div>
</template>
