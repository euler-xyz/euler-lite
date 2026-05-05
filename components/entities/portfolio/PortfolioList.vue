<script setup lang="ts">
import type { AccountBorrowPosition, AccountDepositPosition } from '~/entities/account'
import type { Reward } from '~/entities/merkl'
import type { Campaign } from '~/entities/brevis'
import type { FuulClaimableReward } from '~/entities/fuul'

defineProps<{
  type: 'lend' | 'borrow' | 'earn' | 'rewards' | 'brevis-rewards' | 'fuul-rewards'
  items: any[]
}>()
</script>

<template>
  <div
    class="flex flex-col gap-8"
  >
    <template v-if="type === 'lend'">
      <PortfolioSavingItem
        v-for="(position) in items"
        :key="(position as AccountDepositPosition).vault.address"
        :position="position as AccountDepositPosition"
      />
    </template>
    <template v-else-if="type === 'borrow'">
      <PortfolioBorrowItem
        v-for="position in items"
        :key="`${(position as AccountBorrowPosition).collateral.address}-${(position as AccountBorrowPosition).borrow.address}-${(position as AccountBorrowPosition).subAccount}`"
        :position="position as AccountBorrowPosition"
      />
    </template>
    <template v-else-if="type === 'earn'">
      <PortfolioEarnItem
        v-for="(position) in items"
        :key="(position as AccountDepositPosition).vault.address"
        :position="position as AccountDepositPosition"
      />
    </template>
    <template v-else-if="type === 'rewards'">
      <PortfolioRewardItem
        v-for="(reward, idx) in items"
        :key="`position-${idx}`"
        :reward="reward as Reward"
      />
    </template>
    <template v-else-if="type === 'brevis-rewards'">
      <PortfolioBrevisRewardItem
        v-for="(campaign, idx) in items"
        :key="`brevis-${idx}`"
        :campaign="campaign as Campaign"
      />
    </template>
    <template v-else-if="type === 'fuul-rewards'">
      <PortfolioFuulRewardItem
        v-for="(reward, idx) in items"
        :key="`fuul-${idx}`"
        :reward="reward as FuulClaimableReward"
      />
    </template>
  </div>
</template>
