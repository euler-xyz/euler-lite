<script setup lang="ts">
import type { PortfolioBorrowPosition, PortfolioSavingsPosition, UserReward, VaultEntity } from '@eulerxyz/euler-v2-sdk'

defineProps<{
  type: 'lend' | 'borrow' | 'earn' | 'sdk-rewards'
  items: unknown[]
}>()

const getDepositPositionKey = (position: PortfolioSavingsPosition<VaultEntity>) =>
  `${position.subAccount}-${position.position.vaultAddress}`
const getBorrowPositionKey = (position: PortfolioBorrowPosition<VaultEntity>) =>
  `${position.subAccount}-${position.borrow.vaultAddress}-${position.collateral?.vaultAddress ?? position.collateralVaults[0] ?? 'none'}`
</script>

<template>
  <div
    class="flex flex-col gap-8"
  >
    <template v-if="type === 'lend'">
      <PortfolioSavingItem
        v-for="(position) in items"
        :key="getDepositPositionKey(position as PortfolioSavingsPosition<VaultEntity>)"
        :position="position as PortfolioSavingsPosition<VaultEntity>"
      />
    </template>
    <template v-else-if="type === 'borrow'">
      <PortfolioBorrowItem
        v-for="position in items"
        :key="getBorrowPositionKey(position as PortfolioBorrowPosition<VaultEntity>)"
        :position="position as PortfolioBorrowPosition<VaultEntity>"
      />
    </template>
    <template v-else-if="type === 'earn'">
      <PortfolioEarnItem
        v-for="(position) in items"
        :key="getDepositPositionKey(position as PortfolioSavingsPosition<VaultEntity>)"
        :position="position as PortfolioSavingsPosition<VaultEntity>"
      />
    </template>
    <template v-else-if="type === 'sdk-rewards'">
      <PortfolioSdkRewardItem
        v-for="(reward, idx) in items"
        :key="`sdk-reward-${idx}`"
        :reward="reward as UserReward"
      />
    </template>
  </div>
</template>
