<script setup lang="ts">
import type { PortfolioBorrowPosition, PortfolioSavingsPosition, VaultEntity } from '@eulerxyz/euler-v2-sdk'
import type { Reward } from '~/entities/merkl'
import type { Campaign } from '~/entities/brevis'
import type { FuulClaimableReward } from '~/entities/fuul'

defineProps<{
  type: 'lend' | 'borrow' | 'earn' | 'rewards' | 'brevis-rewards' | 'fuul-rewards'
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
