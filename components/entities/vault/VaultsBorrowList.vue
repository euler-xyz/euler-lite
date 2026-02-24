<script setup lang="ts">
import type { AnyBorrowVaultPair } from '~/entities/vault'

defineProps<{ items: AnyBorrowVaultPair[] }>()

const { enableEntityBranding } = useDeployConfig()
</script>

<template>
  <div class="flex flex-col -mx-20 -mb-20">
    <!-- Column headers -->
    <div
      class="sticky top-[72px] z-10 grid items-center gap-x-16 pt-16 py-8 px-20 bg-surface border-b border-line-default text-content-tertiary text-p3 mobile:!hidden"
      :class="enableEntityBranding ? 'grid-cols-[2fr_repeat(6,1fr)]' : 'grid-cols-[2fr_repeat(5,1fr)]'"
    >
      <div class="pl-20">
        Pair
      </div>
      <div class="pl-[24px]">
        Borrow APY
      </div>
      <div>Max ROE</div>
      <div>Liquidity</div>
      <div>Net APY</div>
      <div v-if="enableEntityBranding">
        Max LTV
      </div>
      <div>
        Utilization
      </div>
    </div>

    <VaultBorrowItem
      v-for="(pair, index) in items"
      :key="`${pair.collateral.address}-${pair.borrow.address}`"
      :pair="pair"
      class="animate-fade-in-up"
      :style="{ animationDelay: `${Math.min(index * 0.03, 0.2)}s` }"
    />
  </div>
</template>
