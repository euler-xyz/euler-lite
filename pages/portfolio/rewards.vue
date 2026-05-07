<script setup lang="ts">
import { useAccount } from '@wagmi/vue'
import { nanoToValue } from '~/utils/crypto-utils'

const { isConnected } = useAccount()
const { isSpyMode } = useSpyMode()
const { enableMerkl, enableIncentra, enableFuul } = useDeployConfig()
const { rewards, isRewardsLoading } = useMerkl()
const { userRewards: brevisRewards, isRewardsLoading: isBrevisRewardsLoading } = useBrevis()
const { unclaimedFuulRewards, isClaimableLoading: isFuulClaimableLoading } = useFuul()
const { locks, isLocksLoading } = useREULLocks()

const hasUnclaimedFuul = computed(() => unclaimedFuulRewards.value.length > 0)

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
            v-else-if="rewards.length === 0"
            class="flex flex-1 min-h-[100px] justify-center items-center"
          >
            <div class="flex flex-col gap-8 items-center text-neutral-500 py-32">
              <div class="flex w-48 h-48 justify-center items-center rounded-12 bg-neutral-100">
                <SvgIcon name="search" />
              </div>
              <template v-if="isConnected || isSpyMode">
                You don't have rewards yet
              </template>
              <template v-else>
                Connect your wallet to see your rewards
              </template>
            </div>
          </div>
          <div
            v-else
            class="flex-1 min-h-[100px]"
          >
            <PortfolioList
              :items="sortedRewards"
              type="rewards"
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
            v-if="isBrevisRewardsLoading"
            class="flex flex-1 min-h-[100px] justify-center items-center"
          >
            <UiLoader class="text-neutral-500" />
          </div>
          <div
            v-else-if="brevisRewards.length === 0"
            class="flex flex-1 min-h-[100px] justify-center items-center"
          >
            <div class="flex flex-col gap-8 items-center text-neutral-500 py-32">
              <div class="flex w-48 h-48 justify-center items-center rounded-12 bg-neutral-100">
                <SvgIcon name="search" />
              </div>
              <template v-if="isConnected || isSpyMode">
                You don't have rewards yet
              </template>
              <template v-else>
                Connect your wallet to see your rewards
              </template>
            </div>
          </div>
          <div
            v-else
            class="flex-1 min-h-[100px]"
          >
            <PortfolioList
              :items="sortedBrevisRewards"
              type="brevis-rewards"
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
            v-if="isFuulClaimableLoading"
            class="flex flex-1 min-h-[100px] justify-center items-center"
          >
            <UiLoader class="text-neutral-500" />
          </div>
          <div
            v-else-if="!hasUnclaimedFuul"
            class="flex flex-1 min-h-[100px] justify-center items-center"
          >
            <div class="flex flex-col gap-8 items-center text-neutral-500 py-32">
              <div class="flex w-48 h-48 justify-center items-center rounded-12 bg-neutral-100">
                <SvgIcon name="search" />
              </div>
              <template v-if="isConnected || isSpyMode">
                You don't have rewards yet
              </template>
              <template v-else>
                Connect your wallet to see your rewards
              </template>
            </div>
          </div>
          <div
            v-else
            class="flex-1 min-h-[100px]"
          >
            <PortfolioList
              :items="unclaimedFuulRewards"
              type="fuul-rewards"
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
          <div class="flex flex-col gap-8 items-center text-neutral-500 py-32">
            <div class="flex w-48 h-48 justify-center items-center rounded-12 bg-neutral-100">
              <SvgIcon name="search" />
            </div>
            <template v-if="isConnected || isSpyMode">
              You don't have locks yet
            </template>
            <template v-else>
              Connect your wallet to see your locks
            </template>
          </div>
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
